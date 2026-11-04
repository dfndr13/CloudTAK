# Cross-plugin API

`cloudtak-plugin-address-search` exposes a small contract for another plugin to use, per
[`docs/PLAN.md`](PLAN.md) §6. There is no package registry in this ecosystem — copy
[`cross-plugin-api.d.ts`](cross-plugin-api.d.ts) into your own plugin's repo for type safety
against the shapes below.

Plugins never import each other's internals here, only CloudTAK core's — so this is data (a
`db.kv` manifest) plus a runtime handle (a `window` global), never an import of this repo's `lib/`.
**Both are absent whenever this plugin isn't installed, hasn't been enabled yet, or has since been
disabled — always check for that before use; don't assume either exists.**

## Knowing what's loaded, without calling into the plugin

```ts
import KV from '../../../src/base/kv.ts'; // your own plugin's core-bridge.ts, per its own §9.1 convention

const raw = await KV.value('addresssearch:manifest');
if (raw) {
    const manifest = JSON.parse(raw); // AddressSearchManifest — see cross-plugin-api.d.ts
    // manifest.datasets: [{ label, region, enabled, kind, addressCount? | recordCount? }, ...]
    // kind: "gazetteer" datasets (place names, e.g. USGS GNIS-derived) carry recordCount instead
    // of addressCount — check `kind` before assuming which one is present.
}
```

Or reactively, via `KV.liveFrom('addresssearch:manifest')` (a Dexie `liveQuery` Observable) — fires
again whenever a dataset is added, removed, or toggled, and once more when the plugin is disabled
(the key is deleted at that point, not left stale).

## Actually searching or geocoding

```ts
const api = window['addresssearch:api'];
if (!api) {
    // not installed, or not enabled yet — degrade gracefully, don't throw
} else {
    const results = await api.search('123 Main St', { limit: 5 });
    const best = await api.geocode('123 Main St'); // convenience: single best match, or undefined
}
```

Both methods degrade internally (an empty array / `undefined`) rather than throwing on an internal
failure — but the primary check is still the global's own presence, since that's what tells you
whether the plugin is there at all.

A result may come from a place-name (gazetteer) dataset instead of a street address — check
`result.sourceKind`. When it's `"gazetteer"`, `featureClass`/`county`/`state` are populated (e.g.
`{ featureClass: "Summit", county: "Coconino", state: "AZ" }`) and every address-only field
(`number`, `streetDisplay`, `city`, `postcode`, `units`) is left at its empty default rather than
holding place data.

## Why a `window` global, not something else

Plugins are separate Vite-bundled repos loaded into one runtime but never importing each other —
only CloudTAK core's own surface. A `db.kv` value can only ever be a string (`DBKV.value`), so it
can carry the manifest but never a live callable. A `window` key is the only import-free way left
to hand over a live reference across that boundary — `window['addresssearch:api']`, matching the
same namespaced-id naming style as the `db.kv` manifest key (`addresssearch:manifest`) rather than
a shared root registry object, since no such registry exists yet in this ecosystem either.
