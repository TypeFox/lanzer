#!/usr/bin/env node
// A stand-in for `codex mcp-server` in tests: an MCP server over stdio with one `codex` tool.
// Each call writes the files FAKE_CODEX_SCRIPT lists for it (Codex writes to disk itself, not
// through the client), appends the prompt it received to FAKE_CODEX_LOG as a JSON line, and
// reports running token totals through a `codex/event` notification the way Codex does.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const script = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCRIPT, 'utf8'));
let calls = 0;

const server = new Server({ name: 'fake-codex', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'codex', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }]
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const prompt = request.params.arguments?.prompt;
    const call = ++calls;
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ call, prompt }) + '\n');
    for (const write of script[call - 1] ?? []) {
        mkdirSync(dirname(write.path), { recursive: true });
        writeFileSync(write.path, write.content ?? '', 'utf8');
    }
    await server.notification({
        method: 'codex/event',
        params: { msg: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 * call, output_tokens: 10 * call, cached_input_tokens: 0, total_tokens: 110 * call } } } }
    });
    return { content: [{ type: 'text', text: `done ${call}` }] };
});

await server.connect(new StdioServerTransport());
