import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import type { LanzerCampaignValidationResult } from '../services/types.js';

/**
 * The tools Lanzer offers the agent during a generation run.
 *
 * Every entry is backed by a service the host language already implements for Lanzer's own
 * end-of-run check — `validate` is the campaign runner, `grammarReference` is the BNF the
 * generation policy already produces. Nothing here asks a host author for anything new, and
 * because the agent and Lanzer call the same implementation, the two cannot disagree about
 * whether a generated file is acceptable.
 *
 * Every field is optional: a host that supplies none simply runs without tools, as before.
 */
export interface LanzerToolkit {
    /** Validate the generated file set as it stands right now. */
    validate?: () => Promise<LanzerCampaignValidationResult>;
    /** The grammar reference for the target language, as text. */
    grammarReference?: () => Promise<string | undefined>;
}

/** One tool invocation, as recorded for the run report. */
export interface LanzerToolCallRecord {
    tool: string;
    startedAtMs: number;
    durationMs: number;
    ok: boolean;
    /** Diagnostic codes returned by this call, in order, including repeats. */
    codes: string[];
    /** Number of issues reported, whether or not they carried codes. */
    issueCount: number;
    /** Set when the tool itself threw rather than reporting a failure. */
    error?: string;
}

export interface LanzerToolHost {
    /** The `mcpServers` entry to hand the agent in `session/new`. */
    readonly descriptor: AcpMcpServer;
    /** Everything the agent called, in order. */
    calls(): readonly LanzerToolCallRecord[];
    close(): Promise<void>;
}

/**
 * Render a validation result as the text the agent reads.
 *
 * Compact and specific on purpose: this is what the agent acts on, so it names the file, the
 * position and the code, and says plainly whether the file set is acceptable. The structured
 * half of the same result goes to {@link LanzerToolCallRecord} and never passes through prose.
 */
function renderValidation(result: LanzerCampaignValidationResult): string {
    const lines: string[] = [result.ok ? 'VALID: every requirement is satisfied.' : 'INVALID:'];
    for (const document of result.documents) {
        if (document.issues.length === 0) continue;
        lines.push(`${document.uri}:`);
        for (const issue of document.issues) {
            const at = issue.line !== undefined ? `:${issue.line}:${issue.character ?? 1}` : '';
            const code = issue.code ? `[${issue.code}] ` : '';
            lines.push(`  ${code}${at ? at + ' ' : ''}${issue.message}`);
        }
    }
    for (const issue of result.workspace?.issues ?? []) lines.push(`  [workspace] ${issue}`);
    for (const issue of result.campaign?.issues ?? []) lines.push(`  [requirement] ${issue}`);
    for (const issue of result.behaviour?.issues ?? []) lines.push(`  [behaviour] ${issue}`);
    return lines.join('\n');
}

function collectCodes(result: LanzerCampaignValidationResult): { codes: string[]; issueCount: number } {
    const codes: string[] = [];
    let issueCount = 0;
    for (const document of result.documents) {
        for (const issue of document.issues) {
            issueCount += 1;
            if (issue.code) codes.push(issue.code);
        }
    }
    issueCount += (result.workspace?.issues.length ?? 0)
        + (result.campaign?.issues.length ?? 0)
        + (result.behaviour?.issues.length ?? 0);
    return { codes, issueCount };
}

/**
 * Serve {@link LanzerToolkit} to the agent, in this process.
 *
 * ACP carries custom tools as MCP, and offers four transports for it. The `acp` one — MCP
 * multiplexed over the connection already open — would need no socket at all, but no agent
 * implements it yet (`claude-agent-acp` 0.75.1 advertises only `http` and `sse`), so this listens
 * on an ephemeral loopback port instead. Still one process: the agent calls back into the same
 * Node instance that spawned it, and every tool body runs on the host's own services.
 *
 * The port is bound to 127.0.0.1 and guarded by a per-run bearer token, because a plain loopback
 * port is reachable by anything else running as this user, and these tools write to the campaign's
 * workspace.
 */
export async function startLanzerToolHost(toolkit: LanzerToolkit): Promise<LanzerToolHost | undefined> {
    const hasTools = Boolean(toolkit.validate ?? toolkit.grammarReference);
    if (!hasTools) {
        return undefined;
    }

    const calls: LanzerToolCallRecord[] = [];
    const token = randomBytes(24).toString('hex');

    /** Time a call, record what it found, and hand the agent the rendered text. */
    const record = async (
        tool: string,
        run: () => Promise<{ text: string; ok: boolean; codes?: string[]; issueCount?: number }>
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> => {
        const startedAtMs = Date.now();
        try {
            const outcome = await run();
            calls.push({
                tool,
                startedAtMs,
                durationMs: Date.now() - startedAtMs,
                ok: outcome.ok,
                codes: outcome.codes ?? [],
                issueCount: outcome.issueCount ?? 0
            });
            return { content: [{ type: 'text', text: outcome.text }] };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            calls.push({
                tool,
                startedAtMs,
                durationMs: Date.now() - startedAtMs,
                ok: false,
                codes: [],
                issueCount: 0,
                error: message
            });
            // Reported to the agent as a tool error rather than thrown: a tool that breaks should
            // not end the turn, it should tell the agent this route is unavailable.
            return { content: [{ type: 'text', text: `Tool failed: ${message}` }], isError: true };
        }
    };

    /**
     * A server with the toolkit's tools registered. One is made per request: the tools keep no state
     * between calls, and a server bound to a single stateful transport refuses the `initialize` of
     * every connection after the first — which is what each retry session, and any agent that
     * reconnects, sends.
     */
    const buildServer = (): McpServer => {
        const mcp = new McpServer({ name: 'lanzer', version: '0.0.1' });
        const validate = toolkit.validate;
        if (validate) {
            mcp.registerTool(
                'validate',
                {
                    title: 'Validate generated files',
                    description:
                        'Check the files generated for this campaign: parse errors, language diagnostics, ' +
                        'and whether the campaign requirements are satisfied. This is the same check Lanzer ' +
                        'runs at the end, so a VALID result here means the run will pass. Call it after ' +
                        'writing files, and again after each correction.',
                    inputSchema: {}
                },
                async () =>
                    record('validate', async () => {
                        const result = await validate();
                        const { codes, issueCount } = collectCodes(result);
                        return { text: renderValidation(result), ok: result.ok, codes, issueCount };
                    })
            );
        }

        const grammarReference = toolkit.grammarReference;
        if (grammarReference) {
            mcp.registerTool(
                'grammar_reference',
                {
                    title: 'Read the grammar reference',
                    description:
                        'The full grammar of the target language in BNF form. Use it to check what syntax ' +
                        'actually exists before writing code, rather than assuming.',
                    inputSchema: {}
                },
                async () =>
                    record('grammar_reference', async () => {
                        const text = await grammarReference();
                        return {
                            text: text ?? 'No grammar reference is available for this campaign.',
                            ok: text !== undefined
                        };
                    })
            );
        }
        return mcp;
    };

    const server: Server = createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401).end();
            return;
        }
        // Stateless: no session to stream server-initiated messages on, so only POST is served.
        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' }).end();
            return;
        }
        const mcp = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
            void transport.close();
            void mcp.close();
        });
        mcp.connect(transport)
            .then(() => transport.handleRequest(req, res))
            .catch(() => {
                if (!res.headersSent) res.writeHead(500).end();
            });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
        server.close();
        throw new Error('Lanzer tool host could not determine its own port.');
    }

    return {
        descriptor: {
            type: 'http',
            name: 'lanzer',
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: [{ name: 'Authorization', value: `Bearer ${token}` }]
        },
        calls: () => calls,
        close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}
