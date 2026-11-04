# cloudtak-plugin-address-search

An offline-first search bar for CloudTAK, built from [OpenAddresses](https://openaddresses.io)
data (street addresses) and, optionally, [USGS GNIS](https://www.usgs.gov/us-board-on-geographic-names/download-gnis-data)
data (named places — mountains, streams, trailheads, populated places). Search by typing, click a
result to fly there, drop a marker (local or shared), or click the map to find the nearest match to
a point — all without a network connection once the data is loaded. See
[`docs/PLAN.md`](docs/PLAN.md) for the full architecture, and
[`docs/PACK_FORMAT.md`](docs/PACK_FORMAT.md) for the byte-level `.pack` file spec (both the address
container and the gazetteer/place-name container).

All 7 phases of the original plan, plus geoname search (Phases 7-8), are built and live-verified —
see [Development history](#development-history) for what was checked at each phase. This section is
the actual "how do I get this running" guide.

## Setup, step by step

There are four things to do, in order: get address data, turn it into a `.pack` file, install the
plugin into CloudTAK, and — **if more than one person needs to use it** — host that `.pack` file
somewhere everyone's browser can reach it. Skipping the last step is fine for a single-user/dev
setup, but on a shared/production CloudTAK instance it's not optional: without it, every other user
who opens the search bar sees "no datasets loaded" and has no way to fix that themselves.

### 1. Get OpenAddresses data

Download a source export from [batch.openaddresses.io](https://batch.openaddresses.io) or the
[openaddresses/openaddresses](https://github.com/openaddresses/openaddresses) results — pick
whatever county/state/country you need. Each download is a **line-delimited GeoJSON file** (one
JSON `Feature` per line, no wrapping array) with properties named `number`, `street`, `unit`,
`city`, `district`, `region`, `postcode`, `hash`, `lon`, `lat` — that's the exact shape this CLI
expects, and it's what OpenAddresses publishes for every source, so no conversion is needed.

You can combine multiple source files (e.g., every county in a state) into one `.pack` in the next
step — just pass all of them to the same `build` command.

### 2. Build a `.pack` file

```sh
cd cli
npm install
node src/index.ts build /path/to/county1.geojson /path/to/county2.geojson \
  --out az-statewide.pack \
  --region "AZ"
```

- The `build` command's first arguments are one or more OpenAddresses files (as many as you want
  combined into a single pack — one county, or every county in a state).
- `--out <path>` (required) is where the finished `.pack` file gets written.
- `--region <label>` (required) is a free-text label shown in the plugin's UI (e.g. `"AZ"` or
  `"AZ-County1"`) — it's cosmetic, not a data format requirement.
- `--cell-size <degrees>` (optional, default `0.005`) controls the reverse-lookup grid size — the
  default is fine for normal use; you'd only change this for a very sparse or very dense region.
  `--chunk-budget <bytes>` (optional) controls internal chunking and almost never needs setting.

That's the whole command. It prints a build report (address count, section sizes, timing) when
done — for reference, a full Arizona statewide export (3.68M addresses) takes about 20 seconds and
produces a 40 MB `.pack` file.

### Optional: place-name (gazetteer) data, from USGS GNIS

Everything above builds a *street-address* pack. The CLI has a second, independent command for
*named places* — summits, streams, trailheads, populated places, and similar — sourced from USGS's
Geographic Names Information System (GNIS) instead of OpenAddresses. It produces its own `.pack`
file, loaded as its own dataset (steps 3-5 below are identical either way — the gear panel
auto-detects which kind of `.pack` it's looking at, no separate control to pick).

**Get the data**: download the state-level "Domestic Names" text export from USGS's
[GNIS download page](https://prd-tnm.s3.amazonaws.com/index.html?prefix=StagedProducts/GeographicNames/DomesticNames/) — a
`|`-delimited text file with a header row, one row per named feature (the file the CLI expects is
literally named e.g. `DomesticNames_AZ.txt`).

**Build the pack**:

```sh
cd cli
npm install
node src/index.ts build-gazetteer /path/to/DomesticNames_AZ.txt \
  --out az-places.pack \
  --region "AZ" \
  --source-name "USGS GNIS Domestic Names (AZ)"
```

- The first argument(s) are one or more GNIS "Domestic Names" export files.
- `--out <path>` / `--region <label>` — same meaning as the address `build` command above.
- `--source-name <name>` (optional, default `"USGS GNIS National File"`) — a free-text label
  recorded in the pack, shown as part of the default dataset label if you don't set one yourself.
- `--cell-size <degrees>` (optional, default `0.02` — larger than the address default, since named
  places are far sparser than addresses) controls the reverse-lookup grid size.
- `--classes <comma-list>` (optional) — GNIS carries dozens of feature classes; by default only a
  field/SAR-relevant allowlist is kept (Summit, Ridge, Valley, Gap, Range, Stream, Lake, Reservoir,
  Falls, Spring, Bay, Populated Place, Locale, Airport, Bridge, Dam, Church, School, Hospital,
  Cemetery, Tower, Mine, Park). Pass `--classes all` to keep every class in the file instead, or
  your own comma-separated list (case-insensitive) to customize it.

For reference, a real Arizona statewide GNIS export (29,777 raw rows) took under a second to build
and produced a 2.57 MB `.pack` file covering 26,705 places.

### 3. Install the plugin into CloudTAK

**Local dev** (symlink — instant reload, never appears in CloudTAK's git status since `plugins/`
is gitignored):

```sh
ln -sfn ~/dev/cloudtak-plugin-address-search ~/CloudTAK/api/web/plugins/address-search
cd ~/CloudTAK/api/web && npm run serve
```

**Production (Docker)**: CloudTAK's own `api/Dockerfile` takes a `WEB_PLUGINS` build argument — a
comma/space-separated list of git URLs — and clones each one into `api/web/plugins/` at build
time (see `api/bin/plugin.ts`). Push this repo to a git remote your build environment can reach,
then add its URL to `WEB_PLUGINS` wherever that's set for your deployment (a `docker-compose.yml`
`build.args` block, or a `--build-arg` flag), and rebuild the `api` image. The Dockerfile runs
`npm run lint && npm run check && npm run build` against the cloned plugin as a hard build gate —
if that fails, the image build fails, so it's worth running the same check yourself first (see
[Verifying a change](#verifying-a-change) below).

### 4. Host the `.pack` files and the pack list

Every browser downloads its data from your CloudTAK server automatically, so the `.pack` files and a
small pack list (`packs.json`) must be reachable over HTTP. The simplest way is serving them from
the **same origin as CloudTAK itself**: no separate container, no CORS, no CSP change, and no
rebuild needed for future data updates. Add a volume to the existing `api` service:

```yaml
services:
  api:
    volumes:
      - ./data/address-packs:/home/etl/app/dist/address-packs:ro
```

(CloudTAK releases before v13.110 used `/home/etl/api/web/dist/address-packs` instead.) Restart the
`api` service once to pick up the mount. Copy the `.pack` files into `./data/address-packs/` on the
host, then write the pack list next to them:

```bash
node cli/src/index.ts pack-list data/address-packs/*.pack \
    --label "state-addresses=State addresses" --label "state-places=State places" \
    --out data/address-packs/packs.json
```

Each pack's `id` is its file name without `.pack` (keep the name the same across rebuilds), and its
`version` is the file's SHA-256. **Re-run `pack-list` every time you add, rebuild or remove a
pack.** See [`docs/HOSTING.md`](docs/HOSTING.md) for why serving from `dist/` works and for an
alternative (a standalone static-file-server container).

### 5. Users get the data automatically

Nobody loads data by hand. Whenever CloudTAK is open and the device is online, the plugin reads
`/address-packs/packs.json` (at start-up, when the device comes back online, and every 6 hours) and:

- downloads any listed pack this browser doesn't have yet, all switched on;
- replaces a pack whose `version` changed, downloading the new copy before removing the old one,
  so search keeps working during an update, and keeping the user's on/off choice;
- removes a pack that is no longer listed;
- puts everything back if the browser's storage was wiped.
- replaces a copy someone loaded by hand from exactly a listed pack's URL with the managed copy.

If the list can't be fetched (offline, server error, missing file), nothing is changed. A short
"Updating …" line shows in the search bar while a download runs. Each browser keeps its own local
copy (see [Architecture](#architecture) for why), so the first download happens once per
device/browser. On iPhones and iPads, adding CloudTAK to the home screen stops Safari from deleting
the data after 7 days without use.

**Manual loading is for CloudTAK system admins only.** Admins (profile `system_admin`) still see
the gear panel's file picker, URL field, remove buttons and online-fallback API keys, for example to
try a new pack in their own browser before adding it to the list. Everyone else only sees what's
loaded and can switch datasets on or off. This hides the controls in the interface; it is not a
security boundary (a manual load only ever affects the user's own browser).

## Architecture

Address data lives entirely in **the browser's own IndexedDB**, not on any CloudTAK server —
that's what makes search instant and fully offline once loaded, and it's why "host the `.pack`
file" (step 4) and "each user loads it once" (step 5) are both necessary: there is no
server-side sync of this data between users, by design (see `docs/PLAN.md` §5 for the full
reasoning — mainly avoiding a memory footprint large enough for iOS Safari to evict the tab).

| Path | Purpose |
|---|---|
| `docs/PLAN.md` | Full 7-phase architecture plan |
| `docs/PACK_FORMAT.md` | Authoritative byte-level spec for the `.pack` container |
| `docs/HOSTING.md` | Full walkthrough for hosting `.pack` files (CORS, `Range`, container example) |
| `docs/cross-plugin-api.d.ts` / `docs/CROSS_PLUGIN_API.md` | The public contract another plugin can use to call into this one — see below |
| `index.ts` | Plugin install/enable/disable lifecycle |
| `lib/normalize.ts` | Street/place text normalization — shared between the CLI (ingest) and the search core (query parsing), so they can never disagree |
| `lib/pack/` | Portable (Node + browser), dependency-free pack reader: string tables, groups, trigrams, cells, chunks, the container/manifest reader, and `PackSource` |
| `lib/search/` | Forward search (query parsing, prefix/fuzzy matching, ranking, number resolution) and reverse lookup (`reverse-lookup.ts`), tied together by the `SearchIndex` class |
| `lib/storage/` | This plugin's own IndexedDB (raw API, no Dexie): dataset CRUD, `IndexedDbPackSource`, both upload paths |
| `lib/worker/` | The dedicated search Worker, its hand-rolled `postMessage` protocol, and the main-thread client |
| `lib/manifest.ts` / `lib/manifest-sync.ts` | The cross-plugin `db.kv` manifest — pure JSON-shape builder vs. the actual CloudTAK write |
| `lib/core-bridge.ts` / `lib/state.ts` | CloudTAK-glue (deep imports for GPS, drop-marker, core-draw mutual exclusion, `db.kv`) and shared module state; excluded from this repo's own tsconfig since they only resolve inside a real CloudTAK checkout |
| `components/` | `AddressSearchToggle` (button) → `AddressSearchBar` (search/results/reverse-lookup) → `AddressSearchGear` (dataset management), `AddressSearchDropPrompt` (marker drop), `AddressSearchHelp` (in-app usage guide) |
| `cli/` | Standalone Node CLI that builds `.pack` files — **never bundled by CloudTAK's Vite**, so unlike `lib/` it carries real npm dependencies |
| `test/` | Vitest specs for `lib/` |
| `bench/run.ts` | Node bench harness — latency percentiles against a real pack |

## Cross-plugin API

Another CloudTAK plugin can check `db.kv['addresssearch:manifest']` (what's loaded) and call
`window['addresssearch:api'].search()`/`.geocode()` (to actually query) without importing this
repo at all. See [`docs/CROSS_PLUGIN_API.md`](docs/CROSS_PLUGIN_API.md) for the full usage pattern
and [`docs/cross-plugin-api.d.ts`](docs/cross-plugin-api.d.ts) for the types to copy into a
consumer plugin.

## Verifying a change

```sh
# Root: search core, storage, worker
npm install && npm test && npx tsc --noEmit

# cli/: the .pack-building CLI
cd cli && npm install && npm test && npx tsc --noEmit
```

Root `tsc` deliberately excludes `lib/core-bridge.ts`, `lib/state.ts`, and `lib/manifest-sync.ts`
(see `tsconfig.json`) — they only resolve once this repo is actually inside a CloudTAK checkout, so
they're verified the same way the `.vue` components are, against the real thing:

```sh
# Check against the REAL plugin location — not a stripped copy. A stripped copy (removing cli/,
# test/, bench/ first) can hide real problems the actual `git clone`-based Docker build would hit,
# since that clones the whole repo unstripped — see the Phase 6 note in Development history.
ln -sfn ~/dev/cloudtak-plugin-address-search ~/CloudTAK/api/web/plugins/address-search
cd ~/CloudTAK/api/web
npx vue-tsc --noEmit
npx eslint --config eslint.config.js ./plugins/address-search/
npm run build   # confirms the worker bundle + full app build still succeed
```

One Node quirk worth knowing: Node 23.6+ runs `.ts` files directly (no build step needed for either
package), but its native TypeScript support only strips *erasable* syntax — constructor
parameter-property shorthand (`constructor(private readonly x: T)`) needs an actual code
transform and fails under `node file.ts` with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, even though
vitest's esbuild transpiler accepts it silently. `lib/` avoids that syntax everywhere so it runs
identically under both.

## Real-data verification

Verified against a real single-county export (Coconino County, AZ — 90,993 addresses) and a real
full-state export (Arizona statewide — 3,683,794 addresses after normalization/dedup), both inside
the plan's target scale. Forward search meets its latency targets (p95 well under 10ms for
exact/prefix matches, under 14ms with fuzzy matching engaged) against the full statewide pack. The
current pipeline holds the whole normalized address set in memory while building a pack (2.15 GB
peak RSS for the statewide build) rather than streaming/external-sorting — fine at this scale, but
worth revisiting if a much larger or lower-memory build environment comes up later.

## What's not built

The optional online-fallback geocode provider (Geoapify/LocationIQ/Radar/HERE, meant to fire only
on an explicit "search online" action after a local miss). The gear panel's API-key storage exists,
but nothing calls out to a provider yet.

## Development history

<details>
<summary>Phase-by-phase build notes, in order — the engineering record of how each phase was verified, real bugs found and fixed, and design decisions made along the way. Not needed to use the plugin; useful if extending it.</summary>

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
3M-address state including the reverse index). Spot-checked several known rows — including two
pulled from deep in the 3.7M-line statewide file — end-to-end (raw feature -> normalize -> pack
bytes -> decode) and every one recovered the exact original coordinates with zero error; also
verified all 45 sections in the statewide pack are byte-contiguous with no gaps/overlaps.

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

45 tests pass at the repo root. This is a dev machine, not the "mid-range phone" the plan's targets
are written for, so the margin matters more than the absolute numbers.

**Phase 3 (UI + Worker + IndexedDB storage) — done, fully live-verified.** The plugin is a real,
installable CloudTAK plugin: `index.ts` (install/enable/disable), a dedicated search Worker
(`lib/worker/`), this plugin's own IndexedDB storage (`lib/storage/` — deliberately separate from
CloudTAK's Dexie `db.kv`, which is string-only), both load paths (file picker and fetch-from-URL,
with Range-request probing and a local-slicing fallback), and three Vue components (button →
search bar → gear panel).

Two real architectural findings, both resolved before writing code: Vite's worker sub-build
doesn't inherit the custom resolver that lets a symlinked plugin bare-import things, so the worker
uses raw `indexedDB` and a hand-rolled `postMessage` RPC instead of Dexie/Comlink. And
`api/web/public/` (Vite's static-passthrough dir) turned out to be git-tracked in this fork, ruling
it out for hosting large pack files — `docs/HOSTING.md` covers the alternative.

**A real bug found and fixed**: the worker was originally instantiated with
`new Worker(new URL('./search-worker.ts', import.meta.url), {type:'module'})`. That URL is
computed at runtime in the browser, so it never passes through Vite's own module-resolution
pipeline — the thing that lets every other import in this plugin reach outside `api/web/` when
symlinked. It hit Vite's raw `server.fs.allow` filesystem check directly and was rejected. Fixed
by switching to Vite's static `?worker&url` import suffix, matching CloudTAK core's own worker
(`atlas.ts`) pattern exactly.

In a real logged-in CloudTAK session: the button renders, the gear panel's file-picker upload of a
real pack succeeds with persisted storage, search returns real results, and clicking a result
flies the map to it. One more real bug surfaced and was fixed along the way: another plugin
(`somewear`) anchors its own floating icon to the identical core-control-stack coordinates with no
cross-plugin coordination, so its icon was painted directly on top of ours (both `position:fixed`,
same z-index) — the button was working the whole time, just invisibly covered. Fixed by replacing
a measure-only collision check in `AddressSearchToggle.vue` with a generic one: probe whatever's
actually rendered at the button's own candidate position via `document.elementsFromPoint()`, walk
up to the nearest `position:fixed` ancestor, and stack below its real bottom edge — generalizes to
any current or future colliding plugin.

**Phase 4 (map integration: drop-marker, local-vs-shared) — done and live-verified.** A pin+
button on each search result opens a per-drop prompt (`AddressSearchDropPrompt.vue`) with an
editable callsign (defaulting to the result's display address) and a point-type picker mirroring
core's own `CoordinateType.vue` (Unknown/Friendly/Hostile/Neutral/Custom, defaulting to the user's
own CloudTAK profile default). "Keep Local" writes an unauthored feature via `lib/core-bridge.ts`'s
`dropMarker()` (mirroring the exact point shape core's own "Draw Point" tool produces); "Save &
Share…" writes it authored and opens core's own `Share.vue` dialog with it pre-loaded. Confirmed
live: the marker appears with the chosen callsign/type either way, and — the exit criterion —
an unauthored marker does **not** reach the network even with an active Mission running.

One integration bug found and fixed: `api.float.add()` only binds props onto a mounted component,
never its emitted events, so core's `Share.vue` did nothing when its close/share buttons were
clicked, leaving the pane stuck open. Fixed with a small wrapper component
(`AddressSearchShareWrapper.vue`) that listens for those emits itself and calls
`api.float.remove()`, rather than editing CloudTAK core.

**A real gap in this repo's own verification convention, found and fixed.** Every prior check
copied the plugin with `cli/`/`test/`/`bench/` stripped out first, specifically so `vue-tsc`'s
unfiltered `include` wouldn't try to typecheck the Node-only CLI tool. That check always passed
clean — but the plugin is actually **symlinked/cloned in unstripped** in real dev/production use,
and two things in the untouched `cli/`/`test/` files broke CloudTAK's own `vue-tsc`/`eslint`/
`vite build` gates against the *real* thing: `vitest.config.ts` (both the root one and `cli/`'s)
used `defineConfig` from `vitest/config`, pulling this plugin's own vitest version's types into
CloudTAK's TS program and conflicting with CloudTAK's own vitest devDependency; and `test/setup.ts`
imported `fake-indexeddb` (a plugin-only test dependency, unresolvable from `api/web`'s own
`node_modules`). Fixed by making both `vitest.config.ts` files plain object literals instead of
`defineConfig(...)` calls, and passing `fake-indexeddb/auto` as a bare string in `setupFiles`
instead of importing it through a local file — vitest resolves that string via Node's own module
resolution at test-run time, never through TypeScript's type-checking pass. **Verify against the
real plugin location going forward** (see [Verifying a change](#verifying-a-change)) — a stripped
copy is useful for isolating plugin-side vs. host-config-side errors, but not sufficient on its
own to prove the plugin won't break CloudTAK's real build.

**Phase 5 (reverse lookup: click → nearest address) — done and live-verified.** A crosshair icon
in the search bar arms a one-shot map-click listener — one click fires the lookup and immediately
detaches itself; clicking returns the nearest address via the same results panel and drop-marker
flow forward search already uses. `SearchIndex.reverseLookup()` decodes the pack's
`cellDir`/`cellLists` sections (built since Phase 1, unread by anything until now) via pure helpers
in `lib/search/reverse-lookup.ts`, widening the search ring generously (up to ~17×17 cells) since
the whole `cellLists` blob is already in hand after one fetch. Click ownership mirrors the measure
plugin's own mutual-exclusion pattern against core's `DrawTool.mode` (a necessarily separate copy
in this plugin's own `core-bridge.ts`, since plugins never import each other's internals); there's
no signal for "another plugin's own tool is active" in this architecture, so the one-shot-arm
design is the real mitigation for that case, not detection. Confirmed live: a click near a known
address returns it, a click far from any data returns a graceful miss, and arming stands down
correctly when core's own Drawing Tools activate.

**Phase 6 (cross-plugin sharing contract) — done and live-verified.** A namespaced `db.kv`
manifest (`addresssearch:manifest`) another plugin can read via `KV.value()`/`KV.liveFrom()`
without calling into this plugin at all, and a runtime lookup API at
`window['addresssearch:api']`. No precedent existed anywhere in this codebase or any sibling
plugin for a cross-plugin runtime handle, so a flat `window` key (matching the `db.kv` key's own
naming style) was the design decided on, rather than inventing a shared registry object nothing
else uses yet.

**A real regression caught and fixed during this phase**: the original design synced the manifest
from inside `lib/storage/dataset-store.ts` (one choke point for every mutation) — but that
transitively pulled `core-bridge.ts`'s CloudTAK-only imports into a file that must stay pure and
unit-testable under plain Node, and broke two existing test suites outright. Fixed by keeping
`dataset-store.ts` untouched and moving the sync call to the UI layer instead — every
dataset-mutating action in `AddressSearchGear.vue`/`AddressSearchBar.vue` now calls
`syncManifestKv()` itself, right after its own `dataset-store.ts` call. Verified live:
`window['addresssearch:api'].search(...)` returns real results in the trimmed public shape;
`db.kv`'s manifest entry correctly reflects the currently-loaded dataset.

93 tests pass at the repo root as of Phase 6 (up from the original 45); `vue-tsc`/`eslint`/
`npm run build` all clean against the real, unstripped plugin location.

**Phase 7 (geoname/place-name ingestion, CLI-only) — done, verified at real state scale.** A
second, independent `build-gazetteer` CLI subcommand and pack "kind" (container version 2) for
named places from USGS GNIS, sharing only the outer container framing with the address pack
(magic/version/manifest/sections) — a wholly different manifest shape and section vocabulary
(`gnNames`, `gnClasses`, `gnPlaces`, flat `gnChunk:<n>` records, `gnTrigrams`, `gnCellDir`/
`gnCellLists`), reusing the address pack's generic low-level codecs (string tables, trigram
postings, the cell-based reverse index) unmodified. Deliberately scoped CLI-only this phase, same
staging the original plan used for addresses (build the format and tooling before any UI work).

**A real bug found and fixed against real data**: the initial dedup key (name + class + county +
state) was too loose — a real 29,777-row AZ GNIS export has, e.g., nine distinct "Government
Spring"s in Yavapai County alone, tens of km apart, which a location-blind key silently collapsed
into one. Fixed by rounding coordinates (~11m) into the key. Also found: the real file's header
uses `state_name` ("Arizona") rather than the assumed `state_alpha` ("AZ") — the column resolver
now tries both by name rather than assuming a fixed column. 50 CLI tests pass (up from 33),
verified end-to-end against a real Arizona statewide GNIS export: 29,777 raw rows → 26,705 kept
records, 2.57 MB pack, sub-second build time.

**Phase 8 (browser: load and search gazetteer packs) — done and live-verified.** The browser
reader/`GazetteerIndex`/worker/UI side of Phase 7's format — the plugin now reads a gazetteer
`.pack` through the exact same gear-panel file/URL flow as an address pack, auto-detected from the
pack's own version byte (no new UI control). A new `GazetteerIndex` (`lib/search/gazetteer-index.ts`)
holds a gazetteer dataset **fully resident** rather than lazily chunk-caching like `SearchIndex` —
a deliberate simplification justified by scale (a real state-level pack is tens of thousands of
records, not the tens of millions an address `SearchIndex` is built for) — and reuses the address
path's generic prefix/fuzzy/reverse-lookup primitives almost entirely unmodified. `SearchResult`
gained optional `sourceKind`/`featureClass`/`county`/`state` fields (widened, not replaced, same
approach Phase 5 used for `matchedVia: "reverse"`), and `DatasetRecord` became a discriminated
union with a read-time backward-compat shim so datasets created before this phase (no `kind` field
in storage at all) keep working with zero migration step. 103 tests pass at the repo root (up from
93); `vue-tsc`/`eslint`/`npm run build` all clean against the real, unstripped plugin location;
live-verified against the real Arizona gazetteer pack from Phase 7 — search, drop-marker, and
crosshair reverse-lookup all correctly return/act on geoname hits merged alongside address results.

</details>
