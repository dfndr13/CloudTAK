/**
 * IndexedDB schema for this plugin's OWN database (`cloudtak-address-search`) — deliberately
 * separate from CloudTAK's Dexie `db.kv`/`db.feature`, which is string-only for `kv` values
 * (docs/PLAN.md §8.4) and the wrong scope entirely for bulk pack data. See docs/PLAN.md §5.
 *
 * Two stores, not the three ("meta"/"dict"/"chunks") PLAN.md §5 originally sketched: every
 * section from the manifest — the small resident ones AND the chunks — gets its own record in
 * `sections`, keyed the same way §5 already specifies for chunks (`datasetId:sectionId`). This is
 * a deliberate simplification: it's what `PackSource.readSection` (lib/pack/pack-source.ts, from
 * Phase 2) already expects one record per call for, so `IndexedDbPackSource` needs no
 * concatenate/re-slice step the way a single pre-joined "dict" blob would.
 */
import { openDatabase, withDatabase } from "./idb.ts";
import type { PackManifest, GazetteerManifest } from "../pack/types.ts";

export const DB_NAME = "cloudtak-address-search";
export const DB_VERSION = 1;
export const DATASETS_STORE = "datasets";
export const SECTIONS_STORE = "sections";

interface DatasetRecordCommon {
    datasetId: string;
    label: string;
    region: string;
    cellSizeDeg: number;
    enabled: boolean;
    createdAt: string;
    /** Set when loaded via the fetch-from-URL path (decision #3) — absent for a file-picker load. */
    sourceUrl?: string;
    /** Result of `navigator.storage.persist()` at load time (docs/PLAN.md §5). */
    persisted: boolean;
    /** Set only for a dataset installed from the server's pack list (lib/managed-packs.ts): the
     *  list entry's `id`. Absent for anything loaded by hand. */
    managedPackId?: string;
    /** The list entry's `version` this dataset was installed from — a change triggers a reload. */
    managedVersion?: string;
}

export interface AddressDatasetRecord extends DatasetRecordCommon {
    kind: "address";
    addressCount: number;
    manifest: PackManifest;
}

export interface GazetteerDatasetRecord extends DatasetRecordCommon {
    kind: "gazetteer";
    recordCount: number;
    manifest: GazetteerManifest;
}

/**
 * A dataset predating Phase 8 (address-only) has no `kind` field at all in storage — real state
 * on the user's own dev/VPS CloudTAK instances, not a hypothetical. `dataset-store.ts`'s
 * `listDatasets`/`getDataset` default a record read back with no `kind` to `"address"` before it
 * ever reaches this type, so every in-memory `DatasetRecord` is always one of these two tagged
 * variants — never require a storage migration step.
 */
export type DatasetRecord = AddressDatasetRecord | GazetteerDatasetRecord;

export function sectionKey(datasetId: string, sectionId: string): string {
    return `${datasetId}:${sectionId}`;
}

function upgrade(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(DATASETS_STORE)) {
        db.createObjectStore(DATASETS_STORE, { keyPath: "datasetId" });
    }
    if (!db.objectStoreNames.contains(SECTIONS_STORE)) {
        db.createObjectStore(SECTIONS_STORE);
    }
}

/** Opens the database for the duration of a multi-step operation. Caller must close it. */
export function openAddressSearchDb(): Promise<IDBDatabase> {
    return openDatabase(DB_NAME, DB_VERSION, upgrade);
}

/** Opens the database, runs `fn`, and closes it afterward — the usual way to touch this store. */
export function withAddressSearchDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    return withDatabase(DB_NAME, DB_VERSION, upgrade, fn);
}
