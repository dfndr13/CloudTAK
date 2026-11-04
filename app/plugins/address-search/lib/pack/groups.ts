import { readI32Array, readU32Array } from "./bytes.ts";
import type { DecodedGroup } from "./types.ts";

/** Decodes the `groups` struct-of-arrays section (see docs/PACK_FORMAT.md). */
export function decodeGroups(bytes: Uint8Array, count: number): DecodedGroup[] {
    const bytesPerArray = count * 4;
    let cursor = 0;

    const streetId = readU32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const placeId = readU32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const postcodeId = readU32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const centroidLat = readI32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const centroidLon = readI32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const chunkId = readU32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const rowOffset = readU32Array(bytes, cursor, count);
    cursor += bytesPerArray;
    const rowCount = readU32Array(bytes, cursor, count);

    const out: DecodedGroup[] = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = {
            streetId: streetId[i]!,
            placeId: placeId[i]!,
            postcodeId: postcodeId[i]!,
            centroidLatE7: centroidLat[i]!,
            centroidLonE7: centroidLon[i]!,
            chunkId: chunkId[i]!,
            rowOffset: rowOffset[i]!,
            rowCount: rowCount[i]!,
        };
    }
    return out;
}
