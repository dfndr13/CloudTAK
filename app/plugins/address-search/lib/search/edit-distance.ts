/**
 * True Damerau-Levenshtein distance (handles adjacent transpositions, e.g. "Mian" -> "Main" is
 * distance 1, not 2). PLAN.md §4.1 step 3 calls for "bounded Damerau-Levenshtein (<=1 edit under
 * 6 chars, <=2 above)" to verify fuzzy trigram candidates — `maxDistance` is that bound; anything
 * beyond it is reported as `maxDistance + 1` rather than computed exactly, since the caller only
 * needs to know "within bound or not."
 */
export function damerauLevenshtein(a: string, b: string, maxDistance: number): number {
    const al = a.length;
    const bl = b.length;
    if (Math.abs(al - bl) > maxDistance) return maxDistance + 1;
    if (a === b) return 0;

    const INF = al + bl;
    // (al+2) x (bl+2) table, 1-indexed with an extra leading row/col per the standard algorithm.
    const d: number[][] = Array.from({ length: al + 2 }, () => new Array<number>(bl + 2).fill(0));
    d[0]![0] = INF;
    for (let i = 0; i <= al; i++) {
        d[i + 1]![0] = INF;
        d[i + 1]![1] = i;
    }
    for (let j = 0; j <= bl; j++) {
        d[0]![j + 1] = INF;
        d[1]![j + 1] = j;
    }

    const lastRowForChar = new Map<string, number>();

    for (let i = 1; i <= al; i++) {
        let lastMatchCol = 0;
        const charA = a[i - 1]!;
        for (let j = 1; j <= bl; j++) {
            const charB = b[j - 1]!;
            const i1 = lastRowForChar.get(charB) ?? 0;
            const j1 = lastMatchCol;

            let cost: number;
            if (charA === charB) {
                cost = 0;
                lastMatchCol = j;
            } else {
                cost = 1;
            }

            d[i + 1]![j + 1] = Math.min(
                d[i]![j]! + cost, // substitution (or match)
                d[i + 1]![j]! + 1, // insertion
                d[i]![j + 1]! + 1, // deletion
                d[i1]![j1]! + (i - i1 - 1) + 1 + (j - j1 - 1), // transposition
            );
        }
        lastRowForChar.set(charA, i);
    }

    const result = d[al + 1]![bl + 1]!;
    return result > maxDistance ? maxDistance + 1 : result;
}

/** PLAN.md §4.1 step 3's bound: <=1 edit under 6 chars, <=2 at 6 chars or more. */
export function editDistanceBoundFor(queryLength: number): number {
    return queryLength < 6 ? 1 : 2;
}
