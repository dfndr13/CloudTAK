/**
 * PLAN.md §6: publishes lib/manifest.ts's pure `buildManifest()` output to CloudTAK's `db.kv`.
 *
 * Deliberately kept separate from lib/manifest.ts (the pure builder) because this file imports
 * lib/core-bridge.ts, which in turn needs `pinia`/CloudTAK's own source tree to even resolve —
 * those modules only exist once this plugin is actually symlinked inside `~/CloudTAK`, so ANY file
 * that imports this one (even just for its exported types) becomes untestable under plain Node.
 * `syncManifestKv()` is therefore called only from .vue components and index.ts — never from
 * lib/storage/* (dataset-store.ts, upload.ts), which must stay pure so their own vitest specs
 * keep working. Each UI mutation call site (AddressSearchGear.vue's upload/remove/toggle,
 * AddressSearchBar.vue's toggle) calls this directly after its own dataset-store.ts call,
 * and index.ts calls it once in `enable()` so a fresh page load is correct immediately.
 */
import { listDatasets } from "./storage/dataset-store.ts";
import { writeManifestKv } from "./core-bridge.ts";
import { buildManifest } from "./manifest.ts";

export async function syncManifestKv(): Promise<void> {
    const datasets = await listDatasets();
    const manifest = buildManifest(datasets);
    await writeManifestKv(JSON.stringify(manifest));
}
