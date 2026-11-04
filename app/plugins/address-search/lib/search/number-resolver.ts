/**
 * PLAN.md §4.1 step 5: binary-search the resolved group's chunk rows (sorted by number ascending
 * within a group) for an exact house-number hit; on a miss, surface the nearest existing number
 * on that street, labeled as such — never interpolate a coordinate that isn't in the data.
 */
import type { DecodedChunkRow, DecodedGroup } from "../pack/types.ts";
import type { NumberMatchKind } from "./types.ts";

export interface NumberResolution {
    row: DecodedChunkRow;
    /** Absolute index into the `rows` array passed in — lets callers scan same-number siblings for units. */
    rowIndex: number;
    matchedVia: NumberMatchKind;
}

/**
 * `targetNumber === null` means the query had no house number at all (e.g. "Main St") — there's
 * no number to resolve against, so this returns the lowest-numbered row in the group as a
 * representative pick, still labeled 'nearest' so callers/UI can show it isn't an exact hit.
 */
export function resolveNumber(
    rows: readonly DecodedChunkRow[],
    group: Pick<DecodedGroup, "rowOffset" | "rowCount">,
    targetNumber: number | null,
): NumberResolution | null {
    const { rowOffset, rowCount } = group;
    if (rowCount === 0) return null;
    if (targetNumber === null) return { row: rows[rowOffset]!, rowIndex: rowOffset, matchedVia: "nearest" };

    let lo = rowOffset;
    let hi = rowOffset + rowCount - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const n = rows[mid]!.number;
        if (n === targetNumber) return { row: rows[mid]!, rowIndex: mid, matchedVia: "exact" };
        if (n < targetNumber) lo = mid + 1;
        else hi = mid - 1;
    }

    // `lo` is the insertion point; the nearest existing number is its neighbour on one side.
    let bestIndex = -1;
    if (lo <= rowOffset + rowCount - 1) bestIndex = lo;
    if (lo - 1 >= rowOffset) {
        const below = rows[lo - 1]!;
        if (bestIndex < 0 || Math.abs(below.number - targetNumber) <= Math.abs(rows[bestIndex]!.number - targetNumber)) {
            bestIndex = lo - 1;
        }
    }
    return bestIndex >= 0 ? { row: rows[bestIndex]!, rowIndex: bestIndex, matchedVia: "nearest" } : null;
}

/**
 * PLAN.md §4.1 step 6 / decision #12: units collapse to the base address. Given a resolved row,
 * scans its contiguous same-number siblings (rows are sorted by number within a group, so
 * same-number rows — one per unit, plus optionally one with no unit — are adjacent) and returns
 * a representative row (the no-unit row if one exists, else the first found) plus every non-empty
 * unit string at that address.
 */
export function collectUnitSiblings(
    rows: readonly DecodedChunkRow[],
    group: Pick<DecodedGroup, "rowOffset" | "rowCount">,
    resolved: NumberResolution,
    units: readonly string[],
): { representative: DecodedChunkRow; unitList: string[] } {
    const { rowOffset, rowCount } = group;
    const groupEnd = rowOffset + rowCount;
    const targetNumber = resolved.row.number;

    let start = resolved.rowIndex;
    while (start - 1 >= rowOffset && rows[start - 1]!.number === targetNumber) start--;
    let end = resolved.rowIndex;
    while (end + 1 < groupEnd && rows[end + 1]!.number === targetNumber) end++;

    let representative = rows[start]!;
    const unitList: string[] = [];
    for (let i = start; i <= end; i++) {
        const row = rows[i]!;
        if (row.unitRef === 0) representative = row;
        else unitList.push(units[row.unitRef] ?? "");
    }
    return { representative, unitList };
}
