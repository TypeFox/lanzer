import { resolveAttemptBudget } from './attempts.js';
import { allowedClaudeTools, resolvePermissionPolicy } from './permissions.js';
import type { LanzerRunConfiguration, RunLanzerAgentTaskOptions } from './types.js';

/**
 * The part of a run's configuration that its options already decide.
 *
 * The transports add what only the live agent can say — its name and version, and the permission
 * mode it actually ran in. A run that fails before reaching the agent is still described by this.
 */
export function describeRunConfiguration(
    options: RunLanzerAgentTaskOptions,
    transport: LanzerRunConfiguration['transport']
): LanzerRunConfiguration {
    const permissions = options.permissions ?? resolvePermissionPolicy(undefined);
    const tools = transport === 'acp' ? allowedClaudeTools(permissions) : undefined;
    const { fixIterations, retryIterations } = resolveAttemptBudget(options);
    return {
        transport,
        command: options.command,
        args: options.args ?? [],
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        allowedToolKinds: [...permissions.allowed].sort(),
        ...(tools ? { toolAllowlist: tools } : {}),
        fixIterations,
        retryIterations,
        // Only Claude's adapter takes the setting; asked of Codex, the run is honestly not isolated.
        isolated: transport === 'acp' && options.isolated === true
    };
}
