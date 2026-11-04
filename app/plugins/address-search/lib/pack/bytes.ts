/**
 * Portable (Node + browser) little-endian byte-array readers. Uses `DataView` rather than typed
 * array constructors directly, so callers never have to worry about the 4-byte alignment
 * requirement typed-array views impose on their backing buffer — `DataView` has no such
 * requirement. See docs/PACK_FORMAT.md for the layouts these read.
 */

export function readU32Array(bytes: Uint8Array, byteOffset: number, count: number): Uint32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, count * 4);
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
    return out;
}

export function readI32Array(bytes: Uint8Array, byteOffset: number, count: number): Int32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, count * 4);
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getInt32(i * 4, true);
    return out;
}

export function readU32(bytes: Uint8Array, byteOffset: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(byteOffset, true);
}
