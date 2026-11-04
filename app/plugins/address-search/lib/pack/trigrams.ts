/**
 * Trigram alphabet/packing (docs/PACK_FORMAT.md "trigrams" section) and postings decode. The
 * pure `packTrigram`/`trigramsOf` functions here are the single source of truth, shared with
 * `cli/src/pack/trigrams.ts` (which builds the postings at pack-build time) so the encoding
 * scheme can never drift between build time and search time.
 */
import { readU32, readU32Array } from "./bytes.ts";
import type { TrigramPostings } from "./types.ts";

export const TRIGRAM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 #";
const BASE = TRIGRAM_ALPHABET.length; // 38
const CHAR_TO_CODE = new Map([...TRIGRAM_ALPHABET].map((c, i) => [c, i]));
const BOUNDARY = "#";

function codeOf(ch: string): number {
    return CHAR_TO_CODE.get(ch) ?? CHAR_TO_CODE.get(" ")!;
}

export function packTrigram(a: string, b: string, c: string): number {
    return (codeOf(a) * BASE + codeOf(b)) * BASE + codeOf(c);
}

/** Every trigram (including boundary-padded edges) present in `matchForm`. */
export function trigramsOf(matchForm: string): number[] {
    const padded = `${BOUNDARY}${matchForm}${BOUNDARY}`;
    const out: number[] = [];
    for (let i = 0; i + 2 < padded.length; i++) {
        out.push(packTrigram(padded[i]!, padded[i + 1]!, padded[i + 2]!));
    }
    return out;
}

export function decodeTrigramPostings(bytes: Uint8Array): TrigramPostings {
    const trigramCount = readU32(bytes, 0);
    let cursor = 4;

    const keys = readU32Array(bytes, cursor, trigramCount);
    cursor += trigramCount * 4;

    const offsets = readU32Array(bytes, cursor, trigramCount + 1);
    cursor += (trigramCount + 1) * 4;

    const postingCount = offsets[trigramCount]!;
    const postings = readU32Array(bytes, cursor, postingCount);

    const trigramKeys = [...keys];
    const postingsByTrigram = trigramKeys.map((_, i) => [...postings.subarray(offsets[i]!, offsets[i + 1]!)]);

    return { trigramKeys, postingsByTrigram };
}
