/**
 * The candidate closest to `name`, when one is close enough to be what the author meant.
 *
 * "Close enough" is at most a third of the name's length in edits, and at least one, so a slip
 * (`FuncDeclaration` for `FunctionDeclaration`, `nmae` for `name`) is caught while a different word
 * of similar length (`code` and `body`) is not offered as if it were one. Case is ignored for the
 * distance, since authors mistype it too; the candidate is returned as it is spelled.
 */
export function nearestName(name: string, candidates: Iterable<string>): string | undefined {
    const wanted = name.toLowerCase();
    const limit = Math.max(1, Math.floor(name.length / 3));
    let best: { candidate: string; distance: number } | undefined;
    for (const candidate of new Set(candidates)) {
        if (candidate === name) continue;
        const distance = editDistance(wanted, candidate.toLowerCase());
        if (distance > limit) continue;
        if (!best || distance < best.distance || (distance === best.distance && candidate < best.candidate)) {
            best = { candidate, distance };
        }
    }
    return best?.candidate;
}

/**
 * Edit distance counting insertions, deletions, substitutions and swaps of two adjacent characters
 * as one edit each (optimal string alignment), so a transposed pair is a single slip.
 */
export function editDistance(a: string, b: string): number {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[a.length][b.length];
}
