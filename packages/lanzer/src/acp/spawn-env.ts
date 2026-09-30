/** The environment for an agent process, without the unset variables `process.env` may carry. */
export function sanitizeSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
