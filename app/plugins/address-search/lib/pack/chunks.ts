import { readI32Array, readU32Array } from "./bytes.ts";
import type { DecodedChunkRow } from "./types.ts";

/** Decodes a (gzip already-inflated) address-chunk section (see docs/PACK_FORMAT.md). */
export function decodeChunkRows(bytes: Uint8Array, rowCount: number): DecodedChunkRow[] {
    const bytesPerArray = rowCount * 4;
    let cursor = 0;

    const number = readU32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const latD = readI32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const lonD = readI32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const unitRef = readU32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const numExtra = readU32Array(bytes, cursor, rowCount);

    const rows: DecodedChunkRow[] = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
        rows[i] = { number: number[i]!, latD: latD[i]!, lonD: lonD[i]!, unitRef: unitRef[i]!, numExtra: numExtra[i]! };
    }
    return rows;
}
