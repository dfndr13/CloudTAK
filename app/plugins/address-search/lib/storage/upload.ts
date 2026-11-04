/**
 * The two load paths from docs/PLAN.md decision #3 — file picker and fetch-from-URL — converge
 * on the same section-by-section write once the bytes are reachable, per §3.5: "the uploader
 * reads the manifest, then File.slice()s each section straight into its own IndexedDB record —
 * streaming, constant memory, resumable, and identical for the file-picker and URL paths."
 */
import { idbPut } from "./idb.ts";
import { withAddressSearchDb, SECTIONS_STORE, sectionKey, type DatasetRecord } from "./schema.ts";
import { createDataset, generateDatasetId, listDatasets, removeSections } from "./dataset-store.ts";
import { readPackManifest, readGazetteerManifest, verifySection } from "../pack/container.ts";
import { PACK_VERSION_GAZETTEER, type PackManifest, type GazetteerManifest } from "../pack/types.ts";

export interface UploadProgress {
    sectionsDone: number;
    sectionsTotal: number;
    bytesDone: number;
    bytesTotal: number;
}

export interface UploadOptions {
    label?: string;
    onProgress?: (progress: UploadProgress) => void;
    /** Overrides the "first dataset is enabled" default (decision #8). */
    enabled?: boolean;
    /** Marks the dataset as installed from the server's pack list (lib/managed-packs.ts). */
    managed?: { id: string; version: string };
}

interface ByteRangeReader {
    /** [start, endExclusive) */
    readRange(start: number, endExclusive: number): Promise<Uint8Array>;
}

function peekManifestLength(headerBytes: Uint8Array): number {
    return new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength).getUint32(8, true);
}

function peekVersion(headerBytes: Uint8Array): number {
    return new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength).getUint32(4, true);
}

type ReadManifestResult =
    | { kind: "address"; manifest: PackManifest }
    | { kind: "gazetteer"; manifest: GazetteerManifest };

/**
 * Detects the pack "kind" from its own version byte (no new UI control needed — the gear panel's
 * existing file-picker/URL-input flow just works for either kind) and routes to the matching
 * reader. This is the ONLY place that decision gets made.
 */
async function readManifest(reader: ByteRangeReader): Promise<ReadManifestResult> {
    const header = await reader.readRange(0, 12);
    const version = peekVersion(header);
    const manifestLength = peekManifestLength(header);
    const full = await reader.readRange(0, 12 + manifestLength);
    return version === PACK_VERSION_GAZETTEER
        ? { kind: "gazetteer", manifest: readGazetteerManifest(full) }
        : { kind: "address", manifest: readPackManifest(full) };
}

async function writeSections(
    reader: ByteRangeReader,
    manifest: PackManifest | GazetteerManifest,
    datasetId: string,
    onProgress?: (p: UploadProgress) => void,
): Promise<void> {
    const bytesTotal = manifest.sections.reduce((sum, s) => sum + s.byteLength, 0);
    let bytesDone = 0;

    await withAddressSearchDb(async (db) => {
        for (let i = 0; i < manifest.sections.length; i++) {
            const section = manifest.sections[i]!;
            const bytes = await reader.readRange(section.byteOffset, section.byteOffset + section.byteLength);
            await verifySection(bytes, section); // throws on checksum mismatch — reject early, per PLAN.md's pack-format-churn mitigation
            await idbPut(db, SECTIONS_STORE, bytes, sectionKey(datasetId, section.id));
            bytesDone += section.byteLength;
            onProgress?.({ sectionsDone: i + 1, sectionsTotal: manifest.sections.length, bytesDone, bytesTotal });
        }
    });
}

/** A load that fails part-way (network drop, bad checksum) would otherwise leave its already
 *  written sections behind with no dataset record pointing at them — dead storage that nothing
 *  ever cleans up. Remove them, then rethrow. */
async function writeSectionsOrCleanUp(
    reader: ByteRangeReader,
    manifest: PackManifest | GazetteerManifest,
    datasetId: string,
    onProgress?: (p: UploadProgress) => void,
): Promise<void> {
    try {
        await writeSections(reader, manifest, datasetId, onProgress);
    } catch (err) {
        await removeSections(datasetId).catch(() => undefined);
        throw err;
    }
}

async function finalizeDataset(
    parsed: ReadManifestResult,
    datasetId: string,
    opts: UploadOptions & { sourceUrl?: string },
): Promise<DatasetRecord> {
    const existing = await listDatasets();
    const enabled = opts.enabled ?? existing.length === 0; // decision #8: default is one enabled
    const managed = opts.managed ? { managedPackId: opts.managed.id, managedVersion: opts.managed.version } : {};
    const input =
        parsed.kind === "address"
            ? {
                  kind: "address" as const,
                  label: opts.label ?? parsed.manifest.region,
                  region: parsed.manifest.region,
                  addressCount: parsed.manifest.addressCount,
                  cellSizeDeg: parsed.manifest.cellSizeDeg,
                  manifest: parsed.manifest,
                  sourceUrl: opts.sourceUrl,
                  ...managed,
              }
            : {
                  kind: "gazetteer" as const,
                  label: opts.label ?? `${parsed.manifest.region} (${parsed.manifest.sourceName})`,
                  region: parsed.manifest.region,
                  recordCount: parsed.manifest.recordCount,
                  cellSizeDeg: parsed.manifest.cellSizeDeg,
                  manifest: parsed.manifest,
                  sourceUrl: opts.sourceUrl,
                  ...managed,
              };
    return createDataset(input, enabled, datasetId);
}

class FileRangeReader implements ByteRangeReader {
    private readonly file: File;

    constructor(file: File) {
        this.file = file;
    }

    async readRange(start: number, endExclusive: number): Promise<Uint8Array> {
        const buf = await this.file.slice(start, endExclusive).arrayBuffer();
        return new Uint8Array(buf);
    }
}

export async function loadFromFile(file: File, opts: UploadOptions = {}): Promise<DatasetRecord> {
    const reader = new FileRangeReader(file);
    const parsed = await readManifest(reader);
    const datasetId = generateDatasetId();
    await writeSectionsOrCleanUp(reader, parsed.manifest, datasetId, opts.onProgress);
    return finalizeDataset(parsed, datasetId, opts);
}

/**
 * Range-request reader for the fetch-from-URL path. Probes support on the FIRST request (the
 * 12-byte header read): a `206 Partial Content` response means the server honors `Range`, so
 * every subsequent section is its own small request (the "streaming, constant memory" property
 * from §3.5). Anything else (a plain `200` with the whole body, which is what a server that
 * ignores `Range` sends) falls back to caching that full response and slicing it locally — still
 * correct, just not constant-memory. This IS the CORS/Range spike PLAN.md's Phase 0 left open,
 * done here against a real host rather than speculated about in advance.
 */
class UrlRangeReader implements ByteRangeReader {
    private readonly url: string;
    private fullBody: Uint8Array | null = null;

    constructor(url: string) {
        this.url = url;
    }

    async readRange(start: number, endExclusive: number): Promise<Uint8Array> {
        if (this.fullBody) return this.fullBody.subarray(start, endExclusive);

        const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${endExclusive - 1}` } });
        if (res.status === 206) {
            return new Uint8Array(await res.arrayBuffer());
        }
        if (res.status === 200) {
            // Server ignored Range and sent everything — remember it so we don't refetch the
            // whole file once per section.
            this.fullBody = new Uint8Array(await res.arrayBuffer());
            return this.fullBody.subarray(start, endExclusive);
        }
        throw new Error(`failed to fetch pack from ${this.url}: HTTP ${res.status}`);
    }
}

export async function loadFromUrl(url: string, opts: UploadOptions = {}): Promise<DatasetRecord> {
    const reader = new UrlRangeReader(url);
    const parsed = await readManifest(reader);
    const datasetId = generateDatasetId();
    await writeSectionsOrCleanUp(reader, parsed.manifest, datasetId, opts.onProgress);
    return finalizeDataset(parsed, datasetId, { ...opts, sourceUrl: url });
}
