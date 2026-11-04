# CloudTAK Address Search — Plan

Plugin repo: `~/dev/cloudtak-plugin-address-search` (writable)
Reference only: `~/CloudTAK`, sibling plugin repos — never edited.

Status: planning complete. CloudTAK surface **verified from source** (§8). Two findings in §9
need your decision before Phase 1.

---

## 1. Locked decisions

| # | Decision |
|---|---|
| 1 | Scale target: one US state, ~1M–6M addresses. Actual size is whatever gets uploaded; nothing may hard-code a limit. |
| 2 | Ingest is a **two-stage pipeline**: an offline Node CLI converts the OpenAddresses zip into a compact pack; the browser only ever consumes the pack. |
| 3 | Two load paths into the same format: **file picker** and **optional fetch-from-URL**. |
| 4 | Matching: house number + street, optional city/ZIP, **typo-tolerant on words only — never on digits**. |
| 5 | Selecting a result **pans/zooms only**. Dropping a marker is a separate, explicit action. |
| 6 | UI: collapsed `IconMapPinSearch` button below the map control stack, expanding into a bar. |
| 7 | Dataset management: empty-state row in the dropdown + gear inside the open bar. No permanent chrome. |
| 8 | Storage is **keyed per dataset** from day one, each with an enable toggle; all enabled datasets are searched. Default is one enabled. |
| 9 | Devices: desktop, Android, **iOS/iPadOS** — iOS is the binding constraint. |
| 10 | Other plugins can read the data, via a **published contract**, with no compile-time dependency on this plugin. |
| 11 | Ranking: nearest to GPS first; automatic fallback to map center when there is no fix. |
| 12 | Units collapse to the base address; the unit list appears after selection. |
| 13 | Local-first, with an **optional, explicitly-triggered** online fallback. |
| 18 | Online fallback uses a **provider adapter** with presets for Geoapify / LocationIQ / Radar / HERE — no display-coupled vendor. |
| 17 | The API key is **per-device** (gear panel), never in the shared `db.kv` manifest, and treated as public. |
| 16 | Dropping a marker **prompts local vs shared each time** (§8.5). |
| 15 | **Reverse geocoding is in scope** — cell index in the pack, plus a toggleable "address at point" map mode. |
| 14 | **No changes to CloudTAK.** No `server/` route, no Dexie schema change, no core patches. Deployed as a real directory under `api/web/plugins/`, it needs no vite edit (§9.1). |

---

## 2. Why the offline prep step

Raw state-level OpenAddresses is 300MB–1.5GB of line-delimited GeoJSON spread across many
county files. In-browser that means minutes of parsing, a multi-hundred-MB memory spike, a
merge step, and a fragile progress UI — on iOS it is a jetsam risk before the index even exists.

Moving that to a CLI means:

- the browser never sees GeoJSON, only a format we control;
- upload becomes a **byte copy**, not an index build — no parse, no CPU spike;
- the runtime code shrinks to a reader plus a matcher, which is the "lightweight" requirement;
- county merge, normalization, and dedup happen once, offline, unattended.

Cost: a file downloaded from openaddresses.io is not directly usable. If that ever matters, a
raw importer can be added later as a separate entry point emitting the same pack — the runtime
does not change.

---

## 3. Data model

### 3.1 Source fields

Each OpenAddresses feature: `number`, `street`, `unit`, `city`, `district`, `region`,
`postcode`, `hash`, plus a point geometry.

### 3.2 Normalization (CLI, once)

- Uppercase, strip punctuation, collapse whitespace.
- Expand/canonicalize suffixes and directionals both ways (`ST`↔`STREET`, `N`↔`NORTH`) so
  "123 N Main Street" and "123 N Main St" hit the same key.
- Keep the display form separate from the match form. Results show `123 N Main St, Mesa AZ 85201`;
  matching runs on the normalized token stream.
- Drop features with no geometry or no number+street.
- Dedup on (street, number, unit, city).

### 3.3 The hierarchy that makes this fast

A state has millions of addresses but only tens of thousands of **distinct street names**, and a
few hundred thousand **(street × place)** groups. Search is really a search over groups; house
numbers are a bounded lookup *after* the group is chosen. That split is the whole performance
story — it keeps the resident, per-keystroke working set small and pushes the bulk to on-demand
reads.

```
streets[]   normalized street names, sorted            ~40–80k    ~1–2 MB
places[]    city / district / postcode strings         ~2–10k     <1 MB
groups[]    (streetId, placeId, postcode, centroid,    ~150–400k  ~4–8 MB
             chunkId, offset, count)
trigrams    trigram -> sorted Uint32Array of streetId  ~1M posts  ~4–6 MB
chunks[]    packed address rows, ~1–4 MB each          bulk       ~35–60 MB
units       sparse: groupId+number -> unit strings     small
cellDir     cellKey -> byte range in cellLists         ~200-400k  ~3 MB
cellLists   delta-varint address ordinals per cell     bulk       ~6-9 MB
```

Resident in the worker: streets, places, groups, trigrams, cellDir — call it **13–20 MB**.
Everything else stays in IndexedDB and is read per-query.

### 3.4 Address row encoding

Structure-of-arrays inside each chunk so a typed-array view is free — no parse on read:

| Field | Type | Notes |
|---|---|---|
| `number` | `Uint32` | sorted within a group; alphanumerics (`123A`, `1/2`) go to a side table |
| `latΔ`, `lonΔ` | `Int32` | 1e-7 degrees, delta from the group centroid (~1cm precision) |
| `unitRef` | `Uint32` | index into the unit table; `0` = none, omitted where a group has no units |

≈12–16 bytes per address → **~40–60 MB for a 3M-address state**, versus ~1GB raw. The reverse
cell index (§4.2) adds **~10–15%**, not the 5–10% first estimated: a raw `Uint32` ordinal per
address is 12 MB on 3M rows, and only delta-varint encoding within each cell brings it down to
~6–9 MB, plus a ~3 MB resident cell directory. Chunks are
gzip'd in the pack and inflated with `DecompressionStream` on write (iOS 16.4+).

### 3.5 Pack container

```
[ 4-byte magic ][ 4-byte version ][ uint32 manifest length ][ manifest JSON ]
[ section 0 ][ section 1 ] ... [ section N ]
```

The manifest lists every section's byte range, kind, and checksum. The uploader reads the
manifest, then `File.slice()`s each section straight into its own IndexedDB record — streaming,
constant memory, resumable, and identical for the file-picker and URL paths.

---

## 4. Search algorithm

### 4.1 Forward — address to point

Runs entirely in a **Web Worker**; the main thread never blocks the map.

1. **Parse** — leading digits → house number. A bare 5-digit trailing token → postcode. Text
   after a comma → place hint. Remainder → street tokens.
2. **Cheap path first** — binary-search the sorted street array for the prefix range. For short
   queries this alone answers, in microseconds, with no fuzzy work.
3. **Fuzzy path** — engaged only when the query is ≥4 chars and the prefix path returns too few
   candidates. Score street ids by shared trigrams, take the top ~200, verify with bounded
   Damerau-Levenshtein (≤1 edit under 6 chars, ≤2 above). This is what makes "Mian Steet" resolve.
4. **Group selection** — gather groups for the matched streets, filter by place/postcode hint if
   present, rank by `(textScore, distanceFromGPS)`. Distance uses the group centroid, already
   resident — no chunk read required to rank.
5. **Number resolution** — for the top ~10 groups only, read the chunk slice (LRU-cached) and
   binary-search the number array. Exact hit wins. On a miss, surface the nearest existing number
   on that street, labeled as such — never interpolate a coordinate that isn't in the data.
6. **Collapse** units to the base address; carry the unit list for the detail view.

Debounce at ~90ms. Target: **<10ms** for the prefix path, **<50ms** with fuzzy engaged, on a
mid-range phone. Phase 2 exists to prove that number before any UI is written.

### 4.2 Reverse lookup — address at a point

Cells are a fixed ~0.005° grid (≈550m N/S, ≈460m E/W at 33°N). Only occupied cells are stored.
`cellDir` is resident and maps a packed `cellKey` to a byte range in `cellLists`; each list is
delta-varint-encoded **global address ordinals**, and the chunk table's cumulative counts turn an
ordinal back into `(chunkId, rowOffset)` with no extra index.

A click reads the target cell plus its 8 neighbours — 9 small IndexedDB reads — decodes the
ordinals, pulls the covering chunk slices, and haversine-sorts. Nine cells guarantee correctness
for any point whose nearest address is within ~450m; beyond that the search widens by a ring
before giving up, which is the right behaviour in rural areas where the nearest address may be
kilometres away.

**Click ownership is the hard part, and it is not a data problem.** Core uses map clicks for CoT
selection, and the measure plugin takes clicks while active. A third consumer needs the same
mutual exclusion measure already does against `DrawTool.mode`: reverse lookup is a *mode* the user
toggles (a crosshair in the expanded bar), never a standing listener, and it must stand down when
core draw or another plugin surface activates.

---

## 5. Storage and the iOS constraint

WKWebView will kill a tab holding a few hundred MB resident, so the index cannot be fully
in-memory. The §3.3 split is what makes it fit: a ~15 MB resident directory, with chunk reads on
demand.

- Bulk data lives in **the plugin's own IndexedDB database** (`cloudtak-address-search`), not in
  CloudTAK's Dexie instance. This is now a hard requirement rather than a preference — see §8.4.
- Call `navigator.storage.persist()` at first load. Without it, iOS may **evict** the whole
  dataset under disk pressure, and the failure mode is silent. The gear panel should show
  persisted-vs-best-effort status.
- Records: `meta` (one per dataset), `dict` (one per dataset), `chunks` (keyed `datasetId:chunkId`).

---

## 6. Cross-plugin contract

Plugins are separate repos sharing one runtime, so the contract is data plus a runtime handle —
never an import.

- A **namespaced manifest key** in CloudTAK's `db.kv` — `addresssearch:manifest` — holding a JSON
  **string** (§8.4: `DBKV.value` is typed `string`, so the packed index can never live here).
  Consumers read it with `KV.value()` or reactively with `KV.liveFrom()`.
- A **runtime lookup API** registered under a namespaced id, exposing `search(query, opts)` and
  `geocode(addressString)`, both promise-returning.
- A published **`.d.ts`** covering the manifest shape, the result shape, and the API surface.
  That file is the public API; consumers degrade gracefully when the key is absent.

---

## 7. Build phases

| Phase | Work | Exit criterion |
|---|---|---|
| **0** | Resolve §9.2; CORS spike on the URL path | Provider and marker type chosen, spike done |
| **1** | Prep CLI + pack format; one county, then the full state | Artifact size and build time measured |
| **2** | Headless search core: reader, worker, matcher, ranker, Node bench harness | Latency targets met, **no CloudTAK involved** |
| **3** | UI: anchored button, expanding bar, dropdown, empty state, gear, upload with progress | Loads a real state pack on an iPad without eviction |
| **4** | Map integration: `flyTo`, drop-marker, local-vs-shared prompt | Local marker never reaches the network with a Mission active |
| **5** | Reverse lookup: cell reads, crosshair mode, mutual exclusion | Click returns nearest address; no click conflict with core or measure |
| **6** | Sharing contract + `.d.ts`; optional online fallback | A second plugin geocodes through the contract |

Phases 1 and 2 need no CloudTAK access at all, which is why they come before any UI.

---

## 8. CloudTAK facts — verified from source

Read from `dfpc-coe/CloudTAK` @ `main` and `clptak/cloudtak-plugin-measure` @ `main`.
**Caveat: upstream, not your fork.** Re-check anything marked ⚠ against `~/CloudTAK`.

### 8.1 Plugin discovery and install
`api/web/src/main.ts:105` globs `['../plugins/*.ts', '../plugins/*/index.ts']` and calls
`.default.install(app, pluginAPI)` at `:113`. Per the measure README, install is
`ln -sfn ~/dev/cloudtak-plugin-<name> ~/CloudTAK/api/web/plugins/<name>`, and `api/web/plugins/`
is gitignored — so the symlink never appears in CloudTAK's git status. Bundling happens from
`~/CloudTAK/api/web` (`npm run serve` / `npm run build`), never from the plugin folder.

### 8.2 Plugin surface (`api/web/plugin.ts`)
`PluginAPI` exposes `app`, `router`, `pinia`, plus getters: `menu`, `routes`,
`map` (returns the raw `mapgl.Map`), `feature` (`list`/`stream` over `db.feature`),
`cot.history`, `breadcrumb.live`, `float` (`add`/`remove`/`has`), and `bottomBar`
(`add`/`remove`). `PluginInstance` is `enable()`/`disable()`; `install()` is static.
**There is no storage API and no search/geocode hook** — which is why §6 defines its own contract.

### 8.3 Button placement
There is no plugin hook on the left map control stack. `MeasureToggle.vue` solves this by
registering through `bottomBar.add()` while rendering `<Teleport to='body'>`, positioning itself
at `getBoundingClientRect().bottom + 8` of `.cloudtak-ctrl-group`, reusing core's
`cloudtak-ctrl-group cloudtak-panel cloudtak-ctrl-btn` classes at `z-index: 4`, and tracking the
stack with a `ResizeObserver` plus a `MutationObserver`. When core hides the stack (non-Default
mode) the query returns null and the button hides itself. **Copy this pattern**, with the
collision fix in §10.

### 8.4 `db.kv` — string values only
`api/web/src/database.ts:136` defines `DBKV { key: string; value: string }`; `:293` registers
`kv: 'key'` in `db.version(2).stores({...})`, so arbitrary namespaced keys are fine.
`api/web/src/base/kv.ts` provides `value()`, `from()`, `liveFrom()` (reactive via Dexie
`liveQuery`), `update()`, `delete()`, `list()`. **`value` is typed `string`**, so a packed binary
index would have to be base64'd at a 33% penalty. Manifest here, bulk in our own IndexedDB.

### 8.5 Map and marker — persistence and distribution are separate
`api.map` is the MapLibre instance, so pan/zoom is a plain `flyTo`/`easeTo`/`fitBounds`.

Writing a marker goes through `useMapStore(pinia).worker.db.add(feature, { authored: true })`
then `store.refresh()`, as `core-bridge.ts:saveLine()` does. In
`src/workers/atlas-database.ts:745+`, `authored` does two things: it stamps
`properties.creator`, and it flips `skipNetwork: !opts.authored` on the mission path.

**The subtlety that makes "local vs shared" non-obvious:** at `atlas-database.ts:771`, a new
authored feature is filed into the **active Mission** whenever one exists. So `authored: true` is
not "local" — with a Data Sync active it publishes. A genuinely local marker is an unauthored
add, which lands in the profile feature branch and persists to `db.feature` only.

Distribution to specific people or channels is a **different mechanism**:
`src/components/CloudTAK/util/Share.vue` is a reusable modal taking `feats?: Feature[]`, resolving
each through `worker.db.get(...).as_feature()` and sharing to contacts or `GroupChannel`s. The
plugin can mount that component rather than reimplementing the marti call.

So the per-drop prompt is: create the feature, then either leave it local (unauthored) or open
`Share.vue` with it. ⚠ Confirm at runtime what an active Mission does to an unauthored add, since
that is the case where "local" could silently become shared.

### 8.6 GPS for ranking
`api/web/src/stores/map.ts:324-335` reads `this.gpsCoordinates`, `this.location`
(a `LocationState` enum, incl. `Disabled` and `Preset`) and `this.locationAccuracy` to feed the
puck. Those are reactive pinia state on the map store — read them directly; fall back to
`map.getCenter()` when `location === Disabled` or `gpsCoordinates` is unset.

### 8.7 Available dependencies (`api/web/package.json`)
`@tabler/icons-vue ^3.0.0` (so `IconMapPinSearch` is a named import, ⚠ confirm the export exists
in the installed version), `dexie ^4.2.1`, `maplibre-gl ^6.0.0`. Plugins declare **no runtime
dependencies** of their own — they resolve against `api/web/node_modules`. The measure plugin's
only devDependency is `vitest`, for testing the dependency-free `lib/` modules; do the same.

---

## 9. Decisions needed before Phase 1

### 9.1 Import style — resolved
`api/web/tsconfig.json` declares `paths` for **`@tak-ps/cloudtak` → `./plugin.ts`** and
`@cloudtak/api-types`, and `vite.config.ts:99-101` declares the same plus **`@` → `./src`**.
The `@` alias exists only in vite, not tsconfig — so `@/stores/map.ts` bundles but fails
`vue-tsc`. That asymmetry is why the measure plugin uses relative depth for deep core imports.

Those depths are correct whenever the plugin lives at a real `api/web/plugins/<name>/`, which is
the deployed case (VPS). The `symlinked-plugin-resolve` hook only matters for the local symlink
dev loop, where Vite resolves to the realpath outside the tree. **The plugin is standalone
either way; the hook is a local convenience.**

Rules for this plugin:

1. Import the plugin surface via the alias — `import type { PluginAPI, PluginInstance } from '@tak-ps/cloudtak'`.
   Aliased in both vite and tsconfig, symlink-proof, no core edit.
2. Never use `@/...` — it does not typecheck.
3. Confine **every** deep core import to `lib/core-bridge.ts`, using relative depth
   (`../../../src/stores/map.ts`). One file carries all the rebase risk and all the symlink
   sensitivity.

Only two things force a deep import, because `PluginAPI` does not cover them:

| Need | Why the alias is not enough |
|---|---|
| GPS for ranking | `gpsCoordinates` / `location` / `locationAccuracy` live on the map store; `PluginAPI` exposes only `map` |
| Drop-marker write | `api.feature` is read-only (`list`/`stream`); writes go through `mapStore.worker.db.add` |

Reading `KV` also needs a deep import (`../../../src/base/kv.ts`). All three go in `core-bridge.ts`.

### 9.2 Online fallback — settled shape

A thin `GeocodeProvider` interface (`search(text, near?) => Promise<Result[]>`) with shipped
presets for **Geoapify, LocationIQ, Radar and HERE**. Google and Mapbox standard geocoding are
excluded on purpose: Google sends no CORS headers for browser use and both couple results to
display on their own basemap, which does not hold against MapLibre.

Rules the implementation must honour:

- The key is entered in the gear panel and stored **per-device**. It is never written to the
  `addresssearch:manifest` key, because that key is the cross-plugin contract and readable by any
  plugin. Assume the key is public — restrict it by referrer and rate-cap it at the vendor.
- The fallback fires **only on an explicit "search online" action after a local miss**, never on
  keystroke. This is a cost and rate-limit decision as much as a policy one.
- Render the provider's required attribution in the results list whenever a remote result is shown.
- Remote results are session-only. They are never written into the pack or the local index.

### 9.3 Remaining choices
1. The dropped marker's point CoT type and callsign convention.
2. Dataset label defaults — proposal: derive `region + build date + address count` from the pack
   manifest, with an editable label in the gear panel.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| **Button collision with measure** — both plugins anchor to `.cloudtak-ctrl-group` at `bottom + 8` and would overlap | Give every plugin shell a `data-cloudtak-plugin-btn` attribute; select core's stack by excluding that attribute, then offset by the count of shells sorted by a declared order key. Must also survive measure's `:not(.measure-toggle-shell)` selector — our shell must not be picked up as core's stack |
| **Click contention** between core CoT selection, measure, and reverse mode | Reverse is a toggled mode with the same `DrawTool.mode` stand-down measure uses; only one surface owns clicks |
| iOS evicts IndexedDB silently | `navigator.storage.persist()`, plus visible storage status in the gear |
| URL-fetch path blocked by CORS | Spike in Phase 0; file picker is the unaffected default |
| Fork/upstream drift — §8 is read from upstream `main` | Re-check every ⚠ item against `~/CloudTAK` before Phase 3 |
| Core internals rename on rebase | One `lib/core-bridge.ts` holding every reach into core, each accessor degrading rather than throwing — the measure plugin's convention |
| Fuzzy matching too slow on low-end phones | Prefix path handles the common case; fuzzy is gated by query length and candidate count |
| Pack format churn after data is loaded | Version in the header; refuse mismatches with a clear re-import prompt |
