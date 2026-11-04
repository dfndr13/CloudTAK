/** Standard unsigned LEB128 varint decode, used for delta-encoded cell address lists. */

/** Returns [value, bytesConsumed]. */
export function decodeVarint(bytes: Uint8Array, offset: number): [number, number] {
    let result = 0;
    let shift = 0;
    let cursor = offset;
    for (;;) {
        const byte = bytes[cursor]!;
        cursor++;
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return [result >>> 0, cursor - offset];
}
