# cloudtak-plugin-address-search

An address search bar using openaddresses.io for CloudTAK. See [`docs/PLAN.md`](docs/PLAN.md) for
the full architecture and phased plan, and [`docs/PACK_FORMAT.md`](docs/PACK_FORMAT.md) for the
byte-level spec of the `.pack` file this CLI produces.

## Fork: server-managed packs (unreleased)

### Added
- Automatic pack sync (`lib/managed-packs.ts`): browsers install, update and remove datasets to
  match `/address-packs/packs.json` on start-up, when coming back online and every 6 hours. Updates
  download the new copy before removing the old one and keep the user's on/off choice. If the list
  can't be fetched or isn't valid, nothing is changed. One sync at a time across tabs (Web Locks).
  A copy loaded by hand from exactly a listed pack's URL is replaced by the managed copy.
- "Updating …" status line in the search bar while a managed download runs.
- CLI `pack-list` command: writes `packs.json` (id, label, url, SHA-256 version, size).
- `cli/tools/extract_landmarks.py`: builds a landmarks pack input for one US state from
  OpenStreetMap, with README steps.
- README: "About this fork" and "Licence and data credit" sections.

### Changed
- Manual loading (file picker, URL field, remove buttons, online-fallback API keys) is shown only to
  CloudTAK system admins (profile `system_admin`). Other users see what's loaded and can switch
  datasets on or off.
- Removed the "Default dataset (shared)" setting and its one-click "Load" button. It was stored in
  each browser's own `db.kv`, so it was never shared, and the pack list replaces it.
- README setup steps 4 and 5 describe the pack list. The volume path is updated for CloudTAK v13.110
  and later (`/home/etl/app/dist`).
- A query with no comma also tries its trailing words as the town and state.
- A street typed without its direction tries every direction and lists the matches together. Fuzzy
  hits are left out of that list, so a guessed direction can't offer the wrong street.

### Fixed
- A load that fails part-way no longer leaves its already-downloaded sections behind in IndexedDB.
- Place-name search ignores text after a comma (a state or county), which isn't part of the name.
- The cross-plugin API types now document the existing `reference` search option.

## Status

**Phase 1 (offline prep CLI + pack format) — done, verified at full-state scale.** The CLI ingests
OpenAddresses line-delimited GeoJSON, normalizes/dedupes it, and writes the binary pack described
in `docs/PACK_FORMAT.md` (streets, places, groups, trigram postings, gzip'd address chunks, and
the reverse-geocode cell index). 33 tests pass, including a full container round-trip.

Real-data runs against actual OpenAddresses exports:

| | Coconino County, AZ | Arizona (statewide) |
|---|---|---|
| source | 91,892 lines, 27.8 MB | 3,712,316 lines, 1.17 GB |
| addresses | 90,993 (93 dropped, 806 deduped) | 3,683,794 (51 dropped, 28,471 deduped) |
| streets / places / groups | 4,487 / 63 / 4,684 | 83,650 / 637 / 110,401 |
| chunks / trigrams / occupied cells | 1 / 4,623 / 4,300 | 36 / 9,469 / 72,444 |
| build time | ~0.65s wall | ~20s wall |
| peak memory | — | 2.15 GB RSS |
| **pack size** | 1.35 MB | **40.0 MB** |

The statewide number lands right inside `docs/PLAN.md` §3.3's own projection (~35–60 MB for a
3M-address state including the reverse index) — this is the real measurement the Phase 1 exit
criterion asked for, not just the synthetic-fixture pass. Spot-checked several known rows —
including two pulled from deep in the 3.7M-line statewide file — end-to-end (raw feature ->
normalize -> pack bytes -> decode) and every one recovered the exact original coordinates with
zero error; also verified all 45 sections in the statewide pack are byte-contiguous with no
gaps/overlaps. Everything after this (worker-based search, UI, map integration, reverse lookup,
cross-plugin contract) is Phase 2+ and out of scope until then.

**Phase 2 (headless search core) — done, latency targets met on the real statewide pack.**
`lib/search/` implements PLAN.md §4.1's forward-search pipeline — query parsing, the prefix
binary-search path, the trigram/Damerau-Levenshtein fuzzy fallback, group ranking by
match-quality-then-distance, house-number resolution with nearest-number fallback, and unit
collapsing. It's plain, dependency-free TypeScript designed to run unmodified in a browser Worker
later (Phase 3) — it already runs unmodified under Node today, using Node's native Web Crypto and
Streams APIs for the same checksum/gzip logic a browser would use, so there's exactly one
pack-reading implementation, not a Node one and a browser one.

`bench/run.ts` benchmarks it against a real pack, sampling real addresses to build exact/prefix/
typo queries. Against the full Arizona statewide pack (3,683,794 addresses, 83,650 streets):

| | Exact | Prefix | Typo (forces fuzzy) |
|---|---|---|---|
| p50 | 0.01ms | 1.43ms | 3.19ms |
| p95 | 5.46ms | 7.80ms | 13.52ms |
| p99 | 11.63ms | 9.30ms | 18.71ms |
| target (PLAN.md §4.1) | <10ms | <10ms | <50ms |
| **result** | **PASS** | **PASS** | **PASS** |

45 tests pass at the repo root (query parsing, prefix/fuzzy matching, ranking, number resolution,
unit collapsing, and a full `SearchIndex` integration test built from a real pack). This is a dev
machine, not the "mid-range phone" the plan's targets are written for, so the margin matters more
than the absolute numbers — there's real headroom before a UI adds its own overhead.

**Phase 3 (UI + Worker + IndexedDB storage) — done, build-verified; live click-through not yet
tested.** The plugin is now a real, installable CloudTAK plugin: `index.ts` (install/enable/
disable), a dedicated search Worker (`lib/worker/`), this plugin's own IndexedDB storage
(`lib/storage/` — deliberately separate from CloudTAK's Dexie `db.kv`, which is string-only), both
load paths from decision #3 (file picker and fetch-from-URL, with Range-request probing and a
local-slicing fallback), and three Vue components (collapsed button -> expanding search bar ->
gear panel for dataset management).

Two real architectural findings from this phase, both resolved before writing code (see git
history / session record for the full reasoning): Vite's worker sub-build doesn't inherit the
custom resolver that lets a symlinked plugin bare-import things, so the worker uses raw
`indexedDB` and a hand-rolled `postMessage` RPC instead of Dexie/Comlink — zero bare imports in
the worker file at all. And `api/web/public/` (Vite's static-passthrough dir) turned out to be
git-tracked in this fork, ruling it out for hosting large pack files — `docs/HOSTING.md` covers
the recommended alternative (a plain static-file-server container, with a CORS callout).

Verification this pass, in increasing order of realism:
- 74 tests pass at the repo root (up from 45 — storage layer via `fake-indexeddb`, worker
  request/response correlation via a mocked `Worker` global, both upload paths including a
  Range-vs-no-Range fetch mock).
- `npx vue-tsc --noEmit` and `eslint` pass **clean** against a real (non-symlinked) copy in
  `~/CloudTAK/api/web/plugins/`, matching the measure plugin's own documented verification
  process — this is what actually proves the Worker file, the `.vue` components, and the
  `../../plugin.ts` import all typecheck in CloudTAK's real environment, which this repo's own
  tsconfig can't do (it excludes `lib/core-bridge.ts`/`lib/state.ts` for exactly that reason).
- Symlinked in and checked against a real (already-running) CloudTAK dev server: every file in
  the plugin's import graph — `index.ts`, every `lib/` module, all three `.vue` components with
  their scoped styles — loaded and compiled successfully (all 200 OK), with only the expected
  401 (no backend session) in the console.
- **A real bug this surfaced, since fixed**: the worker was originally instantiated with
  `new Worker(new URL('./search-worker.ts', import.meta.url), {type:'module'})`. That URL is
  computed at runtime in the browser, so it never passes through Vite's own module-resolution
  pipeline — the one thing that lets every other import in this plugin reach outside
  `api/web/` when symlinked. It hit Vite's raw `server.fs.allow` filesystem check directly and
  was rejected: `The request id ".../lib/worker/search-worker.ts" is outside of Vite serving
  allow list.` Fixed by switching to Vite's static `?worker&url` import suffix
  (`import SearchWorkerUrl from './search-worker.ts?worker&url'`), which is exactly the pattern
  CloudTAK core's own worker (`atlas.ts`) already uses — confirmed fixed by checking the network
  log directly: the worker bundle now resolves `200 OK` before any login even happens, since the
  import is static and resolves as part of the plugin's own module graph at load time.

**Update: Phase 3 is now fully live-verified.** In a real logged-in CloudTAK session, the button
renders, the gear panel's file-picker upload of a real pack (`cli/output/coconino.pack`, 90,993
addresses) succeeds with persisted storage, search returns real results, and clicking a result
flies the map to it. One real bug surfaced and was fixed along the way: another plugin
(`somewear`) anchors its own floating icon to the identical core-control-stack coordinates with no
cross-plugin coordination, so its icon was painted directly on top of ours (both `position:fixed`,
same z-index) — the button was working the whole time, just invisibly covered. Fixed by replacing
the old measure-only collision check in `AddressSearchToggle.vue` with a generic one: probe
whatever's actually rendered at the button's own candidate position via
`document.elementsFromPoint()`, walk up to the nearest `position:fixed` ancestor, and stack below
its real bottom edge — generalizes to any current or future colliding plugin, not just measure or
somewear specifically.

**Phase 4 (map integration: drop-marker, local-vs-shared) — done and live-verified.** A pin+
button on each search result opens a per-drop prompt (`AddressSearchDropPrompt.vue`) with an
editable callsign (defaulting to the result's display address) and a point-type picker mirroring
core's own `CoordinateType.vue` (Unknown/Friendly/Hostile/Neutral/Custom, defaulting to whatever
the user's own CloudTAK profile default is). "Keep Local" writes an unauthored feature via a new
`lib/core-bridge.ts` function (`dropMarker()`, mirroring the exact point shape core's own "Draw
Point" tool produces); "Save & Share…" writes it authored and opens core's own `Share.vue` dialog
with it pre-loaded. Confirmed live: the marker appears with the chosen callsign/type either way,
and — the Phase 4 exit criterion itself — an unauthored ("Keep Local") marker does **not** reach
the network even with an active Mission running. One integration bug found and fixed along the
way: `api.float.add()` only binds props onto a mounted component, never its emitted events, so
core's `Share.vue` — which expects a `close`/`done` listener on its header X and Share/Broadcast
buttons — did nothing when clicked and left the pane stuck open. Fixed with a small wrapper
component (`AddressSearchShareWrapper.vue`) that listens for those emits itself and calls
`api.float.remove()`, rather than editing CloudTAK core.

**A real gap in this repo's own verification convention, found and fixed 2026-08-28.** Every prior
check copied the plugin into `~/CloudTAK/api/web/plugins/` with `cli/`/`test/`/`bench/` stripped
out first, specifically so `vue-tsc`'s unfiltered `include` wouldn't try to typecheck the Node-only
CLI tool. That check always passed clean — but the plugin is actually **symlinked in unstripped**
in real dev/production use, and two things in the untouched-until-now `cli/`/`test/` files broke
CloudTAK's own `vue-tsc`/`eslint`/`vite build` gates against the *real* symlink: `vitest.config.ts`
(both the root one and `cli/`'s) used `defineConfig` from `vitest/config`, pulling this plugin's
own vitest version's types into CloudTAK's TS program and conflicting with CloudTAK's own vitest
devDependency; and `test/setup.ts` imported `fake-indexeddb` (a plugin-only test dependency,
correctly never a runtime import, but still unresolvable from `api/web`'s own `node_modules`).
Fixed by making both `vitest.config.ts` files plain object literals instead of `defineConfig(...)`
calls (functionally identical to vitest at runtime — `defineConfig` is only a TS type-helper, not
required), and passing `fake-indexeddb/auto` as a bare string in `setupFiles` instead of importing
it through a local `test/setup.ts` — vitest resolves that string via Node's own module resolution
at test-run time, never through TypeScript's type-checking pass, exactly like the worker's own
`?worker&url` string import already sidesteps typed resolution for the same underlying reason.
Also cleaned up a few CloudTAK-host-eslint-only complaints stripping never caught (`bench/run.ts`'s
`prefer-const`, unused `eslint-disable` comments for rules the host config doesn't enable, unused
`MockWorker` constructor params). Re-verified against the real unstripped symlink directly (not a
stripped copy): `vue-tsc --noEmit`, `eslint`, and `npm run build` (with `search-worker-*.js`
correctly landing in `dist/assets/`) all clean. **Going forward, verify against the real symlink
directly** (`~/CloudTAK/api/web/plugins/address-search`, already present) rather than only the
stripped copy — the stripped copy still has a place for isolating whether an error is plugin-side
vs. host-config-side, but it is not sufficient on its own to prove the plugin won't break
CloudTAK's own build.

**Phase 5 (reverse lookup: click → nearest address) — done and live-verified.** A crosshair icon
in the search bar arms a one-shot map-click listener (PLAN.md §4.2's "never a standing listener" —
one click fires the lookup and immediately detaches itself); clicking returns the nearest address
via the same results panel and drop-marker flow forward search already uses. New
`SearchIndex.reverseLookup()` decodes the pack's `cellDir`/`cellLists` sections (built since Phase
1, unread by anything until now) via new pure helpers in `lib/search/reverse-lookup.ts`: turning a
click point into candidate global address ordinals (widening the search ring generously — up to
~17×17 cells — since the whole `cellLists` blob is already in hand after one fetch, so widening
costs nothing but in-memory binary searches), then an ordinal back into `(chunkId, rowOffset)` via
a resident prefix-sum over chunk row counts, then into the owning group (for its centroid/street/
place) via a resident groups-by-chunk index. Reuses `collectUnitSiblings()` and
`formatDisplayAddress()` unchanged, so a reverse hit is a real `SearchResult` — no new
result-rendering UI needed. Click ownership mirrors the measure plugin's own mutual-exclusion
pattern against core's `DrawTool.mode` (necessarily a separate copy in this plugin's own
`core-bridge.ts` — plugins never import each other's internals); there is no signal for "another
plugin's own tool is active" in this architecture, so the one-shot-arm design is the real
mitigation for that case, not detection. 88 tests pass (up from 74); `vue-tsc`/`eslint`/`npm run
build` all clean against the real symlink; confirmed live: a click near a known address returns
it, a click far from any data returns a graceful miss, and arming stands down correctly when
core's own Drawing Tools activate.

**Phase 6 (cross-plugin sharing contract) — done and live-verified. All 7 phases of the original
plan are now complete.** Two pieces, per `docs/PLAN.md` §6: a namespaced `db.kv` manifest
(`addresssearch:manifest`, a JSON string — `DBKV.value` is string-only) another plugin can read via
`KV.value()`/`KV.liveFrom()` to know coverage without calling into this plugin at all; and a
runtime lookup API at `window['addresssearch:api']` (`search()`/`geocode()`) — see
[`docs/cross-plugin-api.d.ts`](docs/cross-plugin-api.d.ts) and
[`docs/CROSS_PLUGIN_API.md`](docs/CROSS_PLUGIN_API.md) for the full public contract and usage
pattern. There's no precedent for a cross-plugin runtime handle anywhere in this codebase or any
sibling plugin — confirmed by checking CloudTAK core and every sibling repo — so a flat `window`
key (matching the `db.kv` key's own naming style) was the design decided on with the user, rather
than inventing a shared registry object nothing else uses yet.

The manifest-building logic is deliberately split: `lib/manifest.ts` (pure JSON-shape projection —
label/region/addressCount/enabled only, never the internal `PackManifest`/storage-status fields)
vs. `lib/manifest-sync.ts` (the actual `db.kv` write, which needs `core-bridge.ts` and so only
resolves once symlinked inside real CloudTAK). **A real regression caught and fixed during this
phase**: the original design synced the manifest from inside `lib/storage/dataset-store.ts` (one
choke point for every mutation) — but that transitively pulled `core-bridge.ts`'s CloudTAK-only
imports into a file that must stay pure and unit-testable under plain Node, and broke two existing
test suites (`dataset-store.spec.ts`, `upload.spec.ts`) outright. Fixed by keeping
`dataset-store.ts` untouched and moving the sync call to the UI layer instead — every
dataset-mutating action in `AddressSearchGear.vue`/`AddressSearchBar.vue` now calls
`syncManifestKv()` itself, right after its own `dataset-store.ts` call. Five call sites instead of
one, but zero regression risk, since `.vue` files were never part of the pure-Node test suite to
begin with. The public result type (`AddressSearchResult`) also deliberately drops
`matchedVia`/`numberMatchedVia`/`score` — internal ranking diagnostics with no meaning to a
consumer, which would otherwise churn the public contract every time ranking internals change.

Verified live: `window['addresssearch:api'].search(...)` returns real results in the trimmed
public shape; `db.kv`'s `addresssearch:manifest` entry (inspected directly via raw `indexedDB`,
database `CloudTAK`, table `kv`) correctly reflects the currently-loaded dataset. 93 tests pass (up
from 88); `vue-tsc`/`eslint`/`npm run build` all clean against the real symlink.

## Layout

| Path | Purpose |
|---|---|
| `docs/PLAN.md` | Full 7-phase architecture plan |
| `docs/PACK_FORMAT.md` | Authoritative byte-level spec for the `.pack` container |
| `docs/HOSTING.md` | Recommended static-file-server setup for the fetch-from-URL load path, with a CORS callout |
| `index.ts` | Plugin install/enable/disable lifecycle |
| `lib/normalize.ts` | Street/place text normalization — shared between the CLI (ingest) and the search core (query parsing), so they can never disagree |
| `lib/pack/` | Portable (Node + browser), dependency-free pack reader: string tables, groups, trigrams, cells, chunks, the container/manifest reader, and `PackSource` |
| `lib/search/` | The forward-search pipeline (query parsing, prefix search, fuzzy trigram matching, ranking, number resolution) and Phase 5's reverse-lookup helpers (`reverse-lookup.ts`), tied together by the `SearchIndex` class |
| `lib/storage/` | This plugin's own IndexedDB (raw API, no Dexie): dataset CRUD, `IndexedDbPackSource`, both upload paths |
| `lib/worker/` | The dedicated search Worker, its hand-rolled `postMessage` protocol, and the main-thread client |
| `lib/core-bridge.ts` / `lib/state.ts` | CloudTAK-glue — deep GPS import and shared module state; excluded from this repo's own tsconfig (need `vue`/`pinia`/CloudTAK internals), verified only via the copy-into-CloudTAK step |
| `components/` | `AddressSearchToggle` (button/shell) -> `AddressSearchBar` (input/results/dataset dropdown) -> `AddressSearchGear` (dataset management, upload, API key) |
| `bench/run.ts` | Node bench harness — latency percentiles against a real pack |
| `test/` | Vitest specs for `lib/` |
| `cli/` | Standalone Node CLI — **never bundled by CloudTAK's Vite**, so unlike `lib/` it carries real npm dependencies |
| `cli/src/ingest/` | OpenAddresses parsing + §3.2 normalization glue (delegates to `lib/normalize.ts`) |
| `cli/src/pack/` | Pack section **builders** (writer side) and the CLI's own Node/Buffer-based decoders, used only by its own round-trip tests |
| `cli/src/bench/report.ts` | Human-readable build report (sizes, timings, counts) |
| `cli/test/` | Vitest specs, including a full pack-container round-trip |
| `cli/fixtures/sample-county.ndjson` | Hand-written synthetic OpenAddresses fixture — reused by both the CLI's tests and the root `SearchIndex` integration test |

Note: `lib/pack/`'s decoders are an independent implementation from `cli/src/pack/`'s, not a
shared one — both must match `docs/PACK_FORMAT.md`, and testing them against real packs the CLI
produced (see `test/search-index.spec.ts`) is a stronger correctness check than sharing code would
be, since it proves two independent readers agree on what the format means.

## Usage

```sh
# Root: search core + storage + worker tests, bench harness
npm install
npm test                              # vitest — 74 specs
npx tsc --noEmit                      # typecheck (excludes lib/core-bridge.ts, lib/state.ts — see below)
node bench/run.ts cli/output/az-statewide.pack   # latency percentiles against a real pack

# cli/: the prep CLI
cd cli
npm install
npm test                              # vitest — 33 specs, including the container round-trip
npx tsc --noEmit                      # typecheck

node src/index.ts build fixtures/sample-county.ndjson \
  --out /tmp/sample.pack \
  --region "TEST-Fixture"
```

`build` accepts multiple input files (one county export per file) and writes one `.pack`
combining all of them. `--cell-size` overrides the reverse-geocode grid (default `0.005`°);
`--chunk-budget` overrides the uncompressed per-chunk byte target (default 2 MB).

### Install and verify against CloudTAK

```sh
# Local dev loop (symlink — never appears in CloudTAK's git status, plugins/ is gitignored)
ln -sfn ~/dev/cloudtak-plugin-address-search ~/CloudTAK/api/web/plugins/address-search
cd ~/CloudTAK/api/web && npm run serve   # or: npm run build

# Full typecheck/lint verification (vue-tsc can't resolve a symlinked plugin's realpath, and its
# default include has no filter, so cli/, test/, and bench/ — none of them part of the deployed
# plugin's own import graph — have to come out of the copy first)
cp -r ~/dev/cloudtak-plugin-address-search ~/CloudTAK/api/web/plugins/_addresssearchcheck
rm -rf ~/CloudTAK/api/web/plugins/_addresssearchcheck/{.git,cli,test,bench,package.json,package-lock.json,vitest.config.ts,tsconfig.json,node_modules}
cd ~/CloudTAK/api/web
npx vue-tsc --noEmit
npx eslint --config eslint.config.js ./plugins/_addresssearchcheck/
rm -rf ~/CloudTAK/api/web/plugins/_addresssearchcheck
```

No build step is needed to run either package — Node 23.6+ runs TypeScript directly via type
stripping, so `node ...` and `vitest` both work unmodified against the `.ts` sources. One catch
that cost some debugging: Node's native TS execution only supports *erasable* syntax, and
TypeScript's constructor parameter-property shorthand (`constructor(private readonly x: T)`)
requires an actual code transform (injecting `this.x = x`) — it fails under `node file.ts` with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` even though vitest's esbuild-based transpiler accepts it
silently. `lib/` avoids it everywhere (plain field declarations + explicit constructor-body
assignment) so it runs the same way under both.

## Real data

Verified against both a real single-county export (Coconino County, AZ) and a real full-state
export (Arizona, 3.68M addresses after normalization/dedup — see Status above), which is squarely
in decision #1's ~1M–6M-address target range. The current pipeline holds the whole normalized
address set in memory before writing the pack (a deliberate Phase 1 simplification, not an
external-sort design); 3.68M addresses peaked at 2.15 GB RSS, comfortably under a typical dev
machine's memory, so this hasn't needed revisiting yet. Would be worth watching if a future,
much larger, or lower-memory build environment makes that assumption inconvenient.

## Plan status

All 7 phases in `docs/PLAN.md` §7 are built and live-verified as of Phase 6 — see the Status
section above for what was checked at each phase. The optional online-fallback provider (§9.2:
Geoapify/LocationIQ/Radar/HERE, an explicit "search online" action after a local miss) is scaffolded
in the gear panel's API-key field but the actual fallback call path has not been built or exercised
— the one piece of the original plan intentionally left for a future pass if the user wants it.
