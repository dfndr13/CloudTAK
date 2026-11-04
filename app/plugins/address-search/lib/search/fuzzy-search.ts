/**
 * PLAN.md §4.1 step 3: score street ids by shared trigrams, take the top ~200, verify with
 * bounded Damerau-Levenshtein. Only engaged by the caller when the prefix path found too few
 * candidates and the query is long enough to make trigram scoring meaningful.
 */
import { trigramsOf } from "../pack/trigrams.ts";
import { damerauLevenshtein, editDistanceBoundFor } from "./edit-distance.ts";
import type { TrigramPostings } from "../pack/types.ts";

const DEFAULT_CANDIDATE_LIMIT = 200;
/** Below this length trigram scoring has too few grams to be meaningful (PLAN.md §4.1 step 3). */
export const MIN_FUZZY_QUERY_LENGTH = 4;

function exactIndexOf(sortedKeys: readonly number[], key: number): number {
    let lo = 0;
    let hi = sortedKeys.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const v = sortedKeys[mid]!;
        if (v === key) return mid;
        if (v < key) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

export function trigramCandidateStreetIds(
    query: string,
    trigrams: TrigramPostings,
    limit = DEFAULT_CANDIDATE_LIMIT,
): number[] {
    const counts = new Map<number, number>();
    for (const key of trigramsOf(query)) {
        const idx = exactIndexOf(trigrams.trigramKeys, key);
        if (idx < 0) continue;
        for (const streetId of trigrams.postingsByTrigram[idx]!) {
            counts.set(streetId, (counts.get(streetId) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id]) => id);
}

export interface FuzzyMatch {
    streetId: number;
    distance: number;
}

/** Verifies trigram candidates with real edit distance, dropping anything outside the bound. */
export function verifyFuzzyCandidates(
    query: string,
    candidateStreetIds: readonly number[],
    streets: readonly string[],
): FuzzyMatch[] {
    const bound = editDistanceBoundFor(query.length);
    const out: FuzzyMatch[] = [];
    for (const streetId of candidateStreetIds) {
        const distance = damerauLevenshtein(query, streets[streetId]!, bound);
        if (distance <= bound) out.push({ streetId, distance });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
}
