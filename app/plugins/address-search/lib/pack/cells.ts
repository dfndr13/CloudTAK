/**
 * Reverse-geocode cell index (PLAN.md §4.2). The cell-key math here is the single source of
 * truth, shared with `cli/src/pack/cells.ts` (which builds the index at pack-build time) — a
 * point's cell key must be computed identically whether it's happening at build time or at
 * reverse-lookup time (Phase 5). See docs/PACK_FORMAT.md for the on-disk layout.
 */
import { readU32Array } from "./bytes.ts";
import { decodeVarint } from "./varint.ts";

// A tiny epsilon nudges values that land within float-rounding distance of a cell boundary (e.g.
// (33.415 + 90) / 0.005 evaluates to 24682.999999999996, not 24683) back onto the correct side.
// It's ~5 orders of magnitude smaller than one cell index step, so it never merges real cells.
const INDEX_EPSILON = 1e-7;

export function lonSteps(cellSizeDeg: number): number {
    return Math.ceil(360 / cellSizeDeg);
}

export function latIdxOf(lat: number, cellSizeDeg: number): number {
    return Math.floor((lat + 90) / cellSizeDeg + INDEX_EPSILON);
}

export function lonIdxOf(lon: number, cellSizeDeg: number): number {
    return Math.floor((lon + 180) / cellSizeDeg + INDEX_EPSILON);
}

export function cellKeyOf(lat: number, lon: number, cellSizeDeg: number): number {
    return latIdxOf(lat, cellSizeDeg) * lonSteps(cellSizeDeg) + lonIdxOf(lon, cellSizeDeg);
}

/**
 * The cell keys within `radius` cells of a point (default 1 = the 9-cell self+neighbours read set
 * for a reverse lookup, PLAN.md §4.2's "correct within ~450m" guarantee). Phase 5's ring-widening
 * calls this with a larger radius when the initial 9 cells come up empty — see
 * `lib/search/reverse-lookup.ts`.
 */
export function neighbourCellKeys(lat: number, lon: number, cellSizeDeg: number, radius = 1): number[] {
    const steps = lonSteps(cellSizeDeg);
    const latIdx = latIdxOf(lat, cellSizeDeg);
    const lonIdx = lonIdxOf(lon, cellSizeDeg);
    const keys: number[] = [];
    for (let dLat = -radius; dLat <= radius; dLat++) {
        for (let dLon = -radius; dLon <= radius; dLon++) {
            keys.push((latIdx + dLat) * steps + (lonIdx + dLon));
        }
    }
    return keys;
}

export function decodeCellDir(bytes: Uint8Array, count: number): { cellKeys: number[]; listOffsets: number[] } {
    const keys = readU32Array(bytes, 0, count);
    const offsets = readU32Array(bytes, count * 4, count + 1);
    return { cellKeys: [...keys], listOffsets: [...offsets] };
}

export function decodeCellList(blob: Uint8Array, start: number, end: number): number[] {
    const ordinals: number[] = [];
    let cursor = start;
    let prev = 0;
    while (cursor < end) {
        const [delta, consumed] = decodeVarint(blob, cursor);
        prev += delta;
        ordinals.push(prev);
        cursor += consumed;
    }
    return ordinals;
}
