import { createHash } from 'node:crypto';
import { resolveAttemptBudget } from './attempts.js';
import { isCodexAgent } from './codex.js';
import { LANZER_EVALUATION_MODE_PROMPT } from './evaluation.js';
import { allowedClaudeTools, resolvePermissionPolicy } from './permissions.js';
import type { LanzerRunConfiguration, RunLanzerAgentTaskOptions } from './types.js';

/**
 * The part of a run's configuration that its options already decide.
 *
 * The transports add what only the live agent can say — its name and version, and the permission
 * mode it actually ran in. A run that fails before reaching the agent is still described by this.
 */
export function describeRunConfiguration(options: RunLanzerAgentTaskOptions): LanzerRunConfiguration {
    const permissions = options.permissions ?? resolvePermissionPolicy(undefined);
    const tools = allowedClaudeTools(permissions);
    // Codex reads AGENTS.md whatever Lanzer asks, so a Codex run is honestly not isolated.
    const isolated = options.isolated === true && !isCodexAgent(options);
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);
    return {
        transport: 'acp',
        command: options.command,
        args: options.args ?? [],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        allowedToolKinds: [...permissions.allowed].sort(),
        ...(tools ? { toolAllowlist: tools } : {}),
        fixIterations,
        retryIterations,
        isolated,
        lanzerTools: options.toolkit !== undefined,
        ...(isolated
            ? { evaluationPromptHash: createHash('sha256').update(LANZER_EVALUATION_MODE_PROMPT).digest('hex') }
            : {})
    };
}
