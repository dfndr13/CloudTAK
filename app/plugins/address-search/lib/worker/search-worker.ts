/**
 * The plugin's dedicated Worker (PLAN.md §4.1: "Runs entirely in a Web Worker; the main thread
 * never blocks the map"). Every import here is a plain relative path into this plugin's own
 * `lib/` — no bare (npm-package) imports at all, deliberately, per the note in ./protocol.ts.
 *
 * Holds one `SearchIndex` per currently-enabled dataset, reloading the set from IndexedDB before
 * each search so a dataset toggled on/off in the gear panel (lib/storage/dataset-store.ts) takes
 * effect on the next query without needing an explicit "refresh" message from the main thread.
 */
import { SearchIndex } from "../search/search-index.ts";
import { GazetteerIndex } from "../search/gazetteer-index.ts";
import { IndexedDbPackSource } from "../storage/pack-source-idb.ts";
import { listDatasets } from "../storage/dataset-store.ts";
import type { DatasetRecord } from "../storage/schema.ts";
import type { GeoPoint, SearchOptions, SearchResult } from "../search/types.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";

/** Anything both index kinds are called through identically here — `search`/`reverseLookup`
 *  have the same signature on `SearchIndex` and `GazetteerIndex`, so callers below don't need to
 *  know which kind they're holding. */
type AnyIndex = SearchIndex | GazetteerIndex;

const indexes = new Map<string, AnyIndex>();

async function ensureLoaded(dataset: DatasetRecord): Promise<AnyIndex> {
    const existing = indexes.get(dataset.datasetId);
    if (existing) return existing;
    const index: AnyIndex =
        dataset.kind === "gazetteer"
            ? await GazetteerIndex.open(new IndexedDbPackSource(dataset.datasetId, dataset.manifest))
            : await SearchIndex.open(new IndexedDbPackSource(dataset.datasetId, dataset.manifest));
    indexes.set(dataset.datasetId, index);
    return index;
}

/** Loads every enabled dataset not already resident, drops any that were disabled/removed. */
async function syncLoadedIndexes(): Promise<DatasetRecord[]> {
    const datasets = await listDatasets();
    const enabled = datasets.filter((d) => d.enabled);
    const enabledIds = new Set(enabled.map((d) => d.datasetId));

    for (const loadedId of [...indexes.keys()]) {
        if (!enabledIds.has(loadedId)) indexes.delete(loadedId);
    }
    await Promise.all(enabled.map((d) => ensureLoaded(d)));
    return enabled;
}

/** Re-sorts results merged across multiple datasets by the same rule lib/search/ranker.ts uses. */
function mergeResults(perDataset: SearchResult[][], limit: number): SearchResult[] {
    const merged = perDataset.flat();
    merged.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY);
    });
    return merged.slice(0, limit);
}

async function handleSearch(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    await syncLoadedIndexes();
    const limit = opts.limit ?? 10;
    const perDataset = await Promise.all([...indexes.values()].map((index) => index.search(query, opts)));
    return mergeResults(perDataset, limit);
}

/** PLAN.md §4.2: nearest address across every currently-enabled dataset, mirroring how forward
 *  search already merges across datasets (decision #8) — just picking the single closest hit
 *  instead of a ranked+limited list. */
async function handleReverseLookup(point: GeoPoint): Promise<SearchResult | undefined> {
    await syncLoadedIndexes();
    const perDataset = await Promise.all([...indexes.values()].map((index) => index.reverseLookup(point)));
    const hits = perDataset.filter((r): r is SearchResult => r !== undefined);
    if (hits.length === 0) return undefined;
    hits.sort((a, b) => (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY));
    return hits[0];
}

/** Each handler takes the request's `args` array as-is; casting to the expected shape is local to each entry. */
const handlers: Record<string, (args: unknown[]) => Promise<unknown>> = {
    search: (args) => handleSearch(args[0] as string, args[1] as SearchOptions | undefined),
    reverseLookup: (args) => handleReverseLookup(args[0] as GeoPoint),
    refresh: () => syncLoadedIndexes(),
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    const { id, method, args } = event.data;
    try {
        const handler = handlers[method];
        if (!handler) throw new Error(`unknown method: ${method}`);
        const result = await handler(args);
        self.postMessage({ id, ok: true, result } satisfies WorkerResponse);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        self.postMessage({ id, ok: false, error } satisfies WorkerResponse);
    }
};
