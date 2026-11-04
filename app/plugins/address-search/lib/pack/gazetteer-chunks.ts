/**
 * Decodes a (gzip already-inflated) `gnChunk:<n>` section — see docs/PACK_FORMAT.md's gazetteer
 * container section. Mirrors `lib/pack/chunks.ts`'s `decodeChunkRows` exactly: pure, portable,
 * no compression here (decompression is `lib/pack/container.ts`'s `gunzip()`, called by whoever
 * reads the section, same as `ChunkCache` already does for address chunks).
 */
import { readI32Array, readU32Array } from "./bytes.ts";
import type { DecodedGazetteerRow } from "./types.ts";

export function decodeGazetteerChunkRows(bytes: Uint8Array, rowCount: number): DecodedGazetteerRow[] {
    const bytesPerArray = rowCount * 4;
    let cursor = 0;

    const nameId = readU32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const classId = readU32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const countyId = readU32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const stateId = readU32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const latE7 = readI32Array(bytes, cursor, rowCount);
    cursor += bytesPerArray;
    const lonE7 = readI32Array(bytes, cursor, rowCount);

    const rows: DecodedGazetteerRow[] = new Array(rowCount);
    for (let i = 0; i < rowCount; i++) {
        rows[i] = {
            nameId: nameId[i]!,
            classId: classId[i]!,
            countyId: countyId[i]!,
            stateId: stateId[i]!,
            latE7: latE7[i]!,
            lonE7: lonE7[i]!,
        };
    }
    return rows;
}
