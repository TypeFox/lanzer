/** Where a run's progress lines go, and how chatty they are. */
export interface RecordingClientProgress {
    label?: string;
    stream?: NodeJS.WritableStream;
    verbose?: boolean;
}

/** Same progress line shape as {@link RecordingClient.emitProgress}, for events outside a session. */
export function emitRunProgress(
    progress: RecordingClientProgress | undefined,
    ...parts: string[]
): void {
    if (!progress) return;
    const stream = progress.stream ?? process.stderr;
    const label = progress.label ? `[${progress.label}] ` : '';
    stream.write(label + parts.filter((part) => part.length > 0).join(' ') + '\n');
}
