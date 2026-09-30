/**
 * What an isolated run tells the agent about itself, appended to its system prompt.
 *
 * Isolation leaves out the user's settings, but the agent still works in a folder inside some
 * project, with that project's other files, other runs' outputs and its own memory within reach.
 * Nothing stops it from reading them, so it is told plainly what the run is for, which removes its
 * reason to go looking — and `outsideReads` shows whether it did anyway.
 */
export const LANZER_EVALUATION_MODE_PROMPT = [
    'You are in evaluation mode: this session measures how well you write code in the target language from the material you are given.',
    'Use only the workspace you were given, the files the task points you at (the language skill, the grammar reference, any reference files) and the Lanzer tools.',
    'Do not read or write memory files, do not search the rest of the repository or your home directory, and do not look at the output of other runs.',
    'If something is missing from that material, work it out from the grammar reference and the tools rather than looking elsewhere.'
].join(' ');

/**
 * The environment an isolated Claude session needs beyond its spawn environment: auto-memory off.
 * `settingSources: []` does not cover it, and a benchmark agent working in a project's folder
 * otherwise reads and writes that project's memory, so runs learn from one another.
 */
export const LANZER_ISOLATED_ENV: Readonly<Record<string, string>> = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
};
