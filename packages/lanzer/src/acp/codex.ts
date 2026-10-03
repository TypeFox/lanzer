import type { RunLanzerAgentTaskOptions } from './types.js';

/** Whether a provider setting names Codex: `codex` or `openai`, in any case. */
export function isCodexProvider(provider: string | undefined): boolean {
    const normalized = provider?.trim().toLowerCase();
    return normalized === 'codex' || normalized === 'openai';
}

/**
 * Whether these settings start Codex: a Codex provider, or the codex-acp adapter as the command.
 *
 * Codex reads `AGENTS.md` whatever Lanzer asks, so a Codex run cannot be isolated, and is not
 * recorded as such.
 */
export function isCodexAgent(options: Pick<RunLanzerAgentTaskOptions, 'provider' | 'command' | 'args'>): boolean {
    return isCodexProvider(options.provider)
        || [options.command ?? '', ...(options.args ?? [])].some((part) => part.includes('codex-acp'));
}
