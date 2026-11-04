/** Mirrors docs/PACK_FORMAT.md. Kept in sync by hand with cli/src/pack/types.ts's writer-side shape. */
export interface PackSectionMeta {
    id: string;
    kind: string;
    byteOffset: number;
    byteLength: number;
    compressed: boolean;
    checksum: string;
    count?: number;
}

export interface PackManifest {
    version: number;
    createdAt: string;
    region: string;
    addressCount: number;
    cellSizeDeg: number;
    sections: PackSectionMeta[];
}

export const PACK_MAGIC = "CTAS";
export const PACK_VERSION = 1;

/** Reserved exclusively for gazetteer (place-name) packs — see docs/PACK_FORMAT.md's "Gazetteer
 *  container (version 2)" section. Kept in sync by hand with cli/src/pack/types.ts. */
export const PACK_VERSION_GAZETTEER = 2;

export interface GazetteerManifest {
    version: number;
    createdAt: string;
    region: string;
    sourceName: string;
    recordCount: number;
    cellSizeDeg: number;
    sections: PackSectionMeta[];
}

export interface DecodedGroup {
    streetId: number;
    placeId: number;
    postcodeId: number;
    centroidLatE7: number;
    centroidLonE7: number;
    chunkId: number;
    rowOffset: number;
    rowCount: number;
}

export interface DecodedChunkRow {
    number: number;
    latD: number;
    lonD: number;
    unitRef: number;
    numExtra: number;
}

export interface TrigramPostings {
    trigramKeys: number[];
    postingsByTrigram: number[][];
}

/** A decoded `gnChunk:<n>` row (see docs/PACK_FORMAT.md's gazetteer section). `latE7`/`lonE7` are
 *  raw absolute 1e-7-degree ints, not pre-divided — same convention as `DecodedChunkRow`'s
 *  `latD`/`lonD` above; division happens at the point of use. */
export interface DecodedGazetteerRow {
    nameId: number;
    classId: number;
    countyId: number;
    stateId: number;
    latE7: number;
    lonE7: number;
}
