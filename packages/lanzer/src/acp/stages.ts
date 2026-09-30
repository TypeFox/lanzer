import type { LanzerRunStage } from '../report/model.js';

/**
 * A run that ended before it produced a result, and the stage of the pipeline it ended at.
 *
 * Thrown by the run instead of the underlying error so the caller can still report the run: which
 * stage failed is the actionable part — a command that does not exist, an agent that refused the
 * session, or one that died mid-turn each point somewhere different.
 */
export class LanzerRunStageError extends Error {
    constructor(
        readonly stage: Extract<LanzerRunStage, 'launch' | 'session' | 'turn'>,
        message: string
    ) {
        super(message);
        this.name = 'LanzerRunStageError';
    }
}

/**
 * Which step of talking to the agent is in progress, if any.
 *
 * A dropped connection can surface as a rejection of the connection itself rather than of the
 * request that was waiting, so the step has to be known from outside that request. Between steps
 * — while Lanzer validates, say — it is `undefined`, and a failure there is Lanzer's own.
 */
export interface StageTracker {
    current?: LanzerRunStageError['stage'];
}

/** Run one step of talking to the agent, attributing any failure to `stage`. */
export async function atStage<T>(
    tracker: StageTracker,
    stage: LanzerRunStageError['stage'],
    work: () => Promise<T>
): Promise<T> {
    tracker.current = stage;
    try {
        const result = await work();
        tracker.current = undefined;
        return result;
    } catch (error) {
        // Left set: the connection's own rejection for the same failure may arrive after this one.
        throw asStageError(error, stage);
    }
}

export function asStageError(error: unknown, stage: LanzerRunStageError['stage']): LanzerRunStageError {
    if (error instanceof LanzerRunStageError) {
        return error;
    }
    return new LanzerRunStageError(stage, error instanceof Error ? error.message : String(error));
}
