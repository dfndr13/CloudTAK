/** PLAN.md §4.1 step 2: binary-search the sorted street array for the query's prefix range. */

function lowerBound(streets: readonly string[], target: string): number {
    let lo = 0;
    let hi = streets.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (streets[mid]! < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export interface PrefixRange {
    /** Inclusive. */
    start: number;
    /** Exclusive. */
    end: number;
}

/**
 * `￿` sorts after every character our normalized street alphabet uses (A-Z, 0-9, space), so
 * `lowerBound(streets, prefix + '￿')` finds the first entry that's no longer a prefix match.
 */
export function prefixRange(streets: readonly string[], prefix: string): PrefixRange {
    if (!prefix) return { start: 0, end: streets.length };
    return { start: lowerBound(streets, prefix), end: lowerBound(streets, prefix + "￿") };
}

export function streetIdsInRange(range: PrefixRange): number[] {
    const ids: number[] = new Array(Math.max(0, range.end - range.start));
    for (let i = range.start; i < range.end; i++) ids[i - range.start] = i;
    return ids;
}
