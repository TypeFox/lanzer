#!/usr/bin/env node
// A scripted ACP agent for tests. It does exactly what FAKE_AGENT_SCRIPT says, one entry per
// prompt in the order prompts arrive (across sessions), and appends every outcome to
// FAKE_AGENT_LOG as a JSON line, so a test can see what the client allowed and refused.
//
// Script: [[step, ...], ...] where a step is one of
//   { "write": "<path>", "content": "<text>" }
//   { "read": "<path>" }
//   { "tool": "<lanzer tool name>" }   — call a tool on the session's MCP server
//   { "exit": <code> }                 — die mid-turn
//
// With FAKE_AGENT_MODES set it also offers session modes, and logs `session` (its `_meta`) and
// `mode` (each session/set_mode) entries.
import { appendFileSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const script = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT, 'utf8'));
const log = (entry) => appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify(entry) + '\n');
/** FAKE_AGENT_MODES: a JSON list of mode ids to offer. Unset, the agent has no modes. */
const modeIds = process.env.FAKE_AGENT_MODES ? JSON.parse(process.env.FAKE_AGENT_MODES) : undefined;
const sessions = new Map();
let prompts = 0;

async function callTool(server, name) {
    const client = new Client({ name: 'fake-agent', version: '0.0.0' });
    const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
    try {
        const result = await client.callTool({ name, arguments: {} });
        return result.content?.map((block) => block.text ?? '').join('\n') ?? '';
    } finally {
        await client.close();
    }
}

async function runStep(step, session, cx, prompt) {
    if ('exit' in step) {
        process.exit(step.exit);
    }
    try {
        if ('write' in step) {
            await cx.request(acp.methods.client.fs.writeTextFile, { sessionId: session.id, path: step.write, content: step.content ?? '' });
            log({ prompt, op: 'write', path: step.write, ok: true });
        } else if ('read' in step) {
            const { content } = await cx.request(acp.methods.client.fs.readTextFile, { sessionId: session.id, path: step.read });
            log({ prompt, op: 'read', path: step.read, ok: true, content });
        } else if ('tool' in step) {
            const text = await callTool(session.mcpServers[0], step.tool);
            log({ prompt, op: 'tool', tool: step.tool, session: session.index, ok: true, text });
        }
    } catch (error) {
        log({ prompt, op: Object.keys(step)[0], path: step.write ?? step.read, tool: step.tool, session: session.index, ok: false, error: String(error?.message ?? error) });
    }
}

acp.agent({ name: 'fake-agent' })
    .onRequest('initialize', () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: 'fake-agent', version: '1.2.3' } }))
    .onRequest('session/new', ({ params }) => {
        const id = `session-${sessions.size + 1}`;
        sessions.set(id, { id, index: sessions.size + 1, mcpServers: params.mcpServers ?? [] });
        if (!modeIds) {
            return { sessionId: id };
        }
        // Offering modes the way Claude Code does, opening in the first; the session's `_meta` is
        // logged so a test can see what the client configured.
        log({ op: 'session', ok: true, meta: JSON.stringify(params._meta ?? null) });
        return {
            sessionId: id,
            modes: { currentModeId: modeIds[0], availableModes: modeIds.map((modeId) => ({ id: modeId, name: modeId })) }
        };
    })
    .onRequest('session/set_mode', ({ params }) => {
        log({ op: 'mode', ok: true, mode: params.modeId });
        return {};
    })
    .onRequest('session/close', () => ({}))
    .onRequest('session/prompt', async ({ params, client }) => {
        const prompt = ++prompts;
        const session = sessions.get(params.sessionId);
        for (const step of script[prompt - 1] ?? []) {
            await runStep(step, session, client, prompt);
        }
        return { stopReason: 'end_turn' };
    })
    .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
