import { readU32, readU32Array } from "./bytes.ts";

/** Decodes a string-table section (see docs/PACK_FORMAT.md). */
export function decodeStringTable(bytes: Uint8Array): string[] {
    const count = readU32(bytes, 0);
    const offsetsStart = 4;
    const offsets = readU32Array(bytes, offsetsStart, count + 1);
    const blobStart = offsetsStart + 4 * (count + 1);

    const decoder = new TextDecoder();
    const out: string[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const start = blobStart + offsets[i]!;
        const end = blobStart + offsets[i + 1]!;
        out[i] = decoder.decode(bytes.subarray(start, end));
    }
    return out;
}
