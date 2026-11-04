/**
 * PLAN.md §6: the pure shape-building half of the cross-plugin manifest. Deliberately has no
 * CloudTAK import at all (unlike lib/manifest-sync.ts, which writes this to `db.kv` and is only
 * ever reachable from .vue components/index.ts) — this file is exactly the "storage layer must
 * stay pure and unit-testable" convention every other lib/storage/* file already follows, split
 * out on purpose so `buildManifest()` can be tested without touching CloudTAK internals at all.
 */
import type { DatasetRecord } from "./storage/schema.ts";

export interface AddressSearchManifestDataset {
    label: string;
    region: string;
    enabled: boolean;
    kind: "address" | "gazetteer";
    /** Present when `kind === "address"`. */
    addressCount?: number;
    /** Present when `kind === "gazetteer"` (Phase 8). */
    recordCount?: number;
}

export interface AddressSearchManifest {
    version: 1;
    updatedAt: string;
    datasets: AddressSearchManifestDataset[];
}

export function buildManifest(datasets: readonly DatasetRecord[]): AddressSearchManifest {
    return {
        version: 1,
        updatedAt: new Date().toISOString(),
        datasets: datasets.map((d) => ({
            label: d.label,
            region: d.region,
            enabled: d.enabled,
            kind: d.kind,
            ...(d.kind === "address" ? { addressCount: d.addressCount } : { recordCount: d.recordCount }),
        })),
    };
}
