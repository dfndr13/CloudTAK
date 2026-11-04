/**
 * CRUD over the `datasets` store. PLAN.md decision #8: storage is keyed per dataset from day
 * one, each with an enable toggle; all enabled datasets are searched, default is one enabled.
 */
import { idbDelete, idbDeleteRange, idbGet, idbGetAll, idbPut, prefixRange } from "./idb.ts";
import { withAddressSearchDb, DATASETS_STORE, SECTIONS_STORE, type DatasetRecord } from "./schema.ts";
import type { PackManifest, GazetteerManifest } from "../pack/types.ts";

/**
 * A dataset stored before Phase 8 has no `kind` field in IndexedDB at all — it's structurally an
 * `AddressDatasetRecord` minus that one field, since address was the only kind that existed then.
 * Every read (`listDatasets`/`getDataset`) passes the raw record through this before it's treated
 * as a `DatasetRecord`, so the rest of the codebase never has to think about the legacy shape.
 * The inner cast is a deliberate storage-boundary crossing, not a lie about `DatasetRecord`'s own
 * shape — same convention as this plugin's other IndexedDB/pack boundary casts.
 */
function normalizeDataset(record: DatasetRecord): DatasetRecord {
    const kind = (record as { kind?: DatasetRecord["kind"] }).kind;
    return kind ? record : ({ ...record, kind: "address" } as DatasetRecord);
}

export function generateDatasetId(): string {
    return crypto.randomUUID();
}

/**
 * Requests persistent storage (docs/PLAN.md §5 — without this, iOS may silently evict the whole
 * dataset under disk pressure). Best-effort: some browsers/contexts don't expose the API at all.
 */
async function requestPersistence(): Promise<boolean> {
    try {
        if (!navigator.storage?.persist) return false;
        return await navigator.storage.persist();
    } catch {
        return false;
    }
}

export async function listDatasets(): Promise<DatasetRecord[]> {
    const records = await withAddressSearchDb((db) => idbGetAll<DatasetRecord>(db, DATASETS_STORE));
    return records.map(normalizeDataset);
}

export async function getDataset(datasetId: string): Promise<DatasetRecord | undefined> {
    const record = await withAddressSearchDb((db) => idbGet<DatasetRecord>(db, DATASETS_STORE, datasetId));
    return record ? normalizeDataset(record) : undefined;
}

export type NewDatasetInput =
    | {
          kind: "address";
          label: string;
          region: string;
          addressCount: number;
          cellSizeDeg: number;
          manifest: PackManifest;
          sourceUrl?: string;
          managedPackId?: string;
          managedVersion?: string;
      }
    | {
          kind: "gazetteer";
          label: string;
          region: string;
          recordCount: number;
          cellSizeDeg: number;
          manifest: GazetteerManifest;
          sourceUrl?: string;
          managedPackId?: string;
          managedVersion?: string;
      };

/**
 * Creates a dataset record. The default-enabled rule (decision #8: "default is one enabled") is
 * the caller's job — this always creates as requested; `upload.ts` checks `listDatasets()` first
 * and only defaults `enabled: true` when it's the very first dataset.
 *
 * `datasetId` can be supplied by the caller (upload.ts generates it up front, since it needs the
 * id to key section records BEFORE the dataset record itself is written) — a fresh one is
 * generated when omitted.
 */
export async function createDataset(
    input: NewDatasetInput,
    enabled: boolean,
    datasetId: string = generateDatasetId(),
): Promise<DatasetRecord> {
    const persisted = await requestPersistence();
    const base = {
        datasetId,
        label: input.label,
        region: input.region,
        cellSizeDeg: input.cellSizeDeg,
        enabled,
        createdAt: new Date().toISOString(),
        sourceUrl: input.sourceUrl,
        persisted,
        ...(input.managedPackId !== undefined ? { managedPackId: input.managedPackId } : {}),
        ...(input.managedVersion !== undefined ? { managedVersion: input.managedVersion } : {}),
    };
    const record: DatasetRecord =
        input.kind === "address"
            ? { ...base, kind: "address", addressCount: input.addressCount, manifest: input.manifest }
            : { ...base, kind: "gazetteer", recordCount: input.recordCount, manifest: input.manifest };
    await withAddressSearchDb((db) => idbPut(db, DATASETS_STORE, record));
    return record;
}

export function setEnabled(datasetId: string, enabled: boolean): Promise<void> {
    return withAddressSearchDb(async (db) => {
        const record = await idbGet<DatasetRecord>(db, DATASETS_STORE, datasetId);
        if (!record) throw new Error(`dataset not found: ${datasetId}`);
        await idbPut(db, DATASETS_STORE, { ...normalizeDataset(record), enabled });
    });
}

export function renameDataset(datasetId: string, label: string): Promise<void> {
    return withAddressSearchDb(async (db) => {
        const record = await idbGet<DatasetRecord>(db, DATASETS_STORE, datasetId);
        if (!record) throw new Error(`dataset not found: ${datasetId}`);
        await idbPut(db, DATASETS_STORE, { ...normalizeDataset(record), label });
    });
}

/** Removes the section records written for a dataset whose record was never created (a load
 *  that failed part-way). Safe to call for an id that has no sections. */
export function removeSections(datasetId: string): Promise<void> {
    return withAddressSearchDb((db) => idbDeleteRange(db, SECTIONS_STORE, prefixRange(`${datasetId}:`)));
}

/** Removes the dataset record and every one of its section records. */
export function removeDataset(datasetId: string): Promise<void> {
    return withAddressSearchDb(async (db) => {
        await idbDeleteRange(db, SECTIONS_STORE, prefixRange(`${datasetId}:`));
        await idbDelete(db, DATASETS_STORE, datasetId);
    });
}
