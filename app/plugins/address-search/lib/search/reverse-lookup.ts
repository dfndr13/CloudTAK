/**
 * PLAN.md §4.2: pure ordinal/cell-key resolution helpers for reverse lookup (address at a point).
 * No I/O here — `SearchIndex.reverseLookup()` owns the chunk/cellLists reads and calls these to
 * turn a click point into a set of candidate global address ordinals, and an ordinal into the
 * `(chunkId, rowOffset)` pair a chunk read needs. Kept separate and dependency-free so it's
 * testable without a real pack, same as `prefix-search.ts`/`number-resolver.ts`.
 */
import { neighbourCellKeys } from "../pack/cells.ts";
import { decodeCellList } from "../pack/cells.ts";
import type { DecodedGroup, PackManifest } from "../pack/types.ts";

/** Cap on how far ring-widening goes before giving up — PLAN.md §4.2's "kilometres away in rural
 *  areas" framing. ~17x17 cells at radius 8 is still a handful of resident binary searches, not an
 *  extra storage read (the whole `cellLists` blob is already in hand by then). */
export const MAX_REVERSE_LOOKUP_RADIUS = 8;

export interface DecodedCellDir {
    cellKeys: number[];
    listOffsets: number[];
}

/** Prefix sum over each `chunk:<n>` section's `count` (already in the manifest — the same field
 *  `ChunkCache.getRows()` uses) — index `i` is the global ordinal of chunk `i`'s first row. */
export function buildChunkFirstOrdinals(manifest: PackManifest): number[] {
    const chunkSections = manifest.sections
        .filter((s) => s.id.startsWith("chunk:"))
        .map((s) => ({ n: Number(s.id.slice("chunk:".length)), count: s.count ?? 0 }))
        .sort((a, b) => a.n - b.n);

    const firstOrdinals: number[] = [];
    let cumulative = 0;
    for (const { count } of chunkSections) {
        firstOrdinals.push(cumulative);
        cumulative += count;
    }
    return firstOrdinals;
}

/** Binary search: which chunk owns a given global ordinal. `chunkFirstOrdinals` must be sorted
 *  ascending (it is, by construction — chunk index order). */
export function chunkForOrdinal(chunkFirstOrdinals: readonly number[], ordinal: number): number {
    let lo = 0;
    let hi = chunkFirstOrdinals.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (chunkFirstOrdinals[mid]! <= ordinal) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** Buckets the already-resident `groups[]` by `chunkId`, sorted by `rowOffset` within each bucket
 *  — "a chunk never splits a group" (docs/PACK_FORMAT.md) means these ranges never overlap. */
export function buildGroupsByChunk(groups: readonly DecodedGroup[]): Map<number, DecodedGroup[]> {
    const byChunk = new Map<number, DecodedGroup[]>();
    for (const group of groups) {
        let bucket = byChunk.get(group.chunkId);
        if (!bucket) {
            bucket = [];
            byChunk.set(group.chunkId, bucket);
        }
        bucket.push(group);
    }
    for (const bucket of byChunk.values()) {
        bucket.sort((a, b) => a.rowOffset - b.rowOffset);
    }
    return byChunk;
}

/** Binary search: which group (already sorted by `rowOffset`) owns a given in-chunk row offset. */
export function groupForRowOffset(groupsInChunk: readonly DecodedGroup[], rowOffset: number): DecodedGroup | undefined {
    let lo = 0;
    let hi = groupsInChunk.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const group = groupsInChunk[mid]!;
        if (rowOffset < group.rowOffset) hi = mid - 1;
        else if (rowOffset >= group.rowOffset + group.rowCount) lo = mid + 1;
        else return group;
    }
    return undefined;
}

/** Binary search `cellDir.cellKeys` (sorted ascending) for an exact cell key match, returning its
 *  index into `cellDir` (both parallel arrays), or `undefined` if that cell has no addresses. */
export function findCellSlot(cellDir: DecodedCellDir, key: number): number | undefined {
    const { cellKeys } = cellDir;
    let lo = 0;
    let hi = cellKeys.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const k = cellKeys[mid]!;
        if (k === key) return mid;
        if (k < key) lo = mid + 1;
        else hi = mid - 1;
    }
    return undefined;
}

/**
 * Every candidate global address ordinal within `radius` cells of a point — the ring-widening
 * search described in PLAN.md §4.2. Starts at `radius = 1` (the 9-cell guarantee) and widens by 1
 * until at least one candidate is found or `MAX_REVERSE_LOOKUP_RADIUS` is exhausted. No extra
 * storage reads between radii — `cellDir` and `cellListsBlob` are both already fully in hand.
 */
export function candidateOrdinals(
    lat: number,
    lon: number,
    cellSizeDeg: number,
    cellDir: DecodedCellDir,
    cellListsBlob: Uint8Array,
): number[] {
    const seenCellKeys = new Set<number>();
    for (let radius = 1; radius <= MAX_REVERSE_LOOKUP_RADIUS; radius++) {
        const ordinals: number[] = [];
        for (const key of neighbourCellKeys(lat, lon, cellSizeDeg, radius)) {
            if (seenCellKeys.has(key)) continue;
            seenCellKeys.add(key);
            const slot = findCellSlot(cellDir, key);
            if (slot === undefined) continue;
            const start = cellDir.listOffsets[slot]!;
            const end = cellDir.listOffsets[slot + 1]!;
            ordinals.push(...decodeCellList(cellListsBlob, start, end));
        }
        if (ordinals.length > 0) return ordinals;
    }
    return [];
}
