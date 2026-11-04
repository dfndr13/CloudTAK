/**
 * A `PackSource` is where pack bytes come from — a plain interface so the search core (`lib/
 * search/`) never cares whether it's talking to a single file (Phase 2's Node bench harness) or
 * per-section IndexedDB records (Phase 3+, the real browser runtime). `readSection` returns
 * verified, still-possibly-compressed bytes; decompression (for chunk sections) happens where
 * the caller actually needs the rows, not here.
 */
import { readPackManifest, getSection, verifySection } from "./container.ts";
import type { PackManifest, GazetteerManifest } from "./types.ts";

export interface PackSource<M = PackManifest> {
    manifest(): Promise<M>;
    readSection(id: string): Promise<Uint8Array>;
}

/**
 * Loads an entire `.pack` file into memory once and slices sections out of it. Good enough for
 * the Phase 2 Node bench harness (packs are tens of MB, not hundreds); the real browser runtime
 * reads sections lazily from IndexedDB instead of holding the whole file resident.
 *
 * Generic over the manifest shape so the same class opens either pack "kind" — pass
 * `readGazetteerManifest` as `readManifestFn` to open a version-2 gazetteer pack (see
 * test/gazetteer-index.spec.ts); every existing address call site is unaffected since the default
 * (`readPackManifest`) and default type param (`PackManifest`) match today's behavior exactly.
 */
export class InMemoryPackSource<M extends PackManifest | GazetteerManifest = PackManifest> implements PackSource<M> {
    private readonly bytes: Uint8Array;
    private readonly readManifestFn: (bytes: Uint8Array) => M;
    private manifestCache: M | undefined;

    // Plain field assignment, not a constructor parameter property — Node's native TypeScript
    // execution only supports erasable syntax, and parameter properties require a real transform
    // (injecting `this.x = x`), so they fail under `node file.ts` even though esbuild-based
    // tooling like vitest silently accepts them. See docs/PACK_FORMAT.md's sibling note in
    // package.json about running .ts files directly with no build step.
    constructor(bytes: Uint8Array, readManifestFn: (bytes: Uint8Array) => M = readPackManifest as (bytes: Uint8Array) => M) {
        this.bytes = bytes;
        this.readManifestFn = readManifestFn;
    }

    async manifest(): Promise<M> {
        if (!this.manifestCache) this.manifestCache = this.readManifestFn(this.bytes);
        return this.manifestCache;
    }

    async readSection(id: string): Promise<Uint8Array> {
        const manifest = await this.manifest();
        const section = getSection(manifest, id);
        const slice = this.bytes.slice(section.byteOffset, section.byteOffset + section.byteLength);
        await verifySection(slice, section);
        return slice;
    }
}

export async function openNodeFilePackSource(filePath: string): Promise<InMemoryPackSource> {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(filePath);
    return new InMemoryPackSource(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}
