/**
 * PLAN.md §4.1 step 5 / §3.3: chunks are read on demand and LRU-cached, since only ~40-60MB of a
 * multi-hundred-MB index (the resident streets/groups/trigrams/cellDir) lives in memory at once.
 */
import { gunzip, getSection } from "../pack/container.ts";
import { decodeChunkRows } from "../pack/chunks.ts";
import type { PackSource } from "../pack/pack-source.ts";
import type { DecodedChunkRow, PackManifest } from "../pack/types.ts";

const DEFAULT_MAX_RESIDENT_CHUNKS = 16;

export class ChunkCache {
    private readonly cache = new Map<number, DecodedChunkRow[]>();
    private readonly source: PackSource;
    private readonly manifest: PackManifest;
    private readonly maxResident: number;

    // Plain field assignment, not constructor parameter properties — see the note in
    // lib/pack/pack-source.ts's constructor for why (Node's native TS execution can't strip them).
    constructor(source: PackSource, manifest: PackManifest, maxResident = DEFAULT_MAX_RESIDENT_CHUNKS) {
        this.source = source;
        this.manifest = manifest;
        this.maxResident = maxResident;
    }

    async getRows(chunkId: number): Promise<DecodedChunkRow[]> {
        const cached = this.cache.get(chunkId);
        if (cached) {
            // Re-insert to mark as most-recently-used (Map iteration order = insertion order).
            this.cache.delete(chunkId);
            this.cache.set(chunkId, cached);
            return cached;
        }

        const section = getSection(this.manifest, `chunk:${chunkId}`);
        const compressed = await this.source.readSection(section.id);
        const raw = section.compressed ? await gunzip(compressed) : compressed;
        const rows = decodeChunkRows(raw, section.count!);

        this.cache.set(chunkId, rows);
        if (this.cache.size > this.maxResident) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        return rows;
    }
}
