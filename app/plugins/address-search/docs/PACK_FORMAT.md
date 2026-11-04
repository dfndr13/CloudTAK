# Pack format

Byte-level spec for the `.pack` file produced by `cli/` and consumed (starting Phase 2) by the
browser plugin. See [`PLAN.md`](PLAN.md) §3 for the rationale and size budgets. This document is
authoritative for the on-disk/on-wire layout; the plan document is authoritative for the reasoning.

All multi-byte integers are little-endian. All coordinates are WGS84 degrees.

## Container

```
offset  size      field
0       4         magic = ASCII "CTAS"
4       4         version : uint32   (currently 1)
8       4         manifestLength : uint32
12      manifestLength   manifest : UTF-8 JSON
12+manifestLength ...    sections, concatenated, each at the byteOffset given in the manifest
```

A reader must check `magic` and refuse (with a re-import prompt, per PLAN.md's pack-format-churn
risk) on any `version` it doesn't recognize. `byteOffset` in the manifest is absolute from the
start of the file, so sections can be read independently via `File.slice()` / `Blob.slice()`
without walking the container sequentially.

### Manifest JSON shape

```ts
interface PackManifest {
  version: number;
  createdAt: string;        // ISO 8601
  region: string;           // free-text label, e.g. "AZ-Maricopa" or "AZ"
  addressCount: number;
  cellSizeDeg: number;      // grid size used for the reverse index, see Cells below
  sections: PackSection[];
}

interface PackSection {
  id: string;                // 'streets' | 'places' | 'groups' | 'trigrams' | 'units'
                              // | 'cellDir' | 'cellLists' | 'numberExtra'
                              // | 'chunk:<n>' for n in [0, chunkCount)
  kind: string;               // codec identifier, see per-section notes
  byteOffset: number;
  byteLength: number;         // length on disk (post-compression, where compressed)
  compressed: boolean;        // true => gzip; DecompressionStream('gzip') on read
  checksum: string;           // sha256 hex of the on-disk (possibly compressed) bytes
  count?: number;             // element count, where relevant (rows, entries, etc.)
}
```

## String table codec (`kind: "string-table"`)

Used for `streets`, `places`, `units`, and `numberExtra`. Layout:

```
offset  size            field
0       4               count : uint32
4       4*(count+1)     offsets : Uint32Array   (byte offsets into blob, ascending, offsets[count] = blob length)
4+4*(count+1)  ...      blob : UTF-8 bytes, strings concatenated with no separator
```

String `i` is `blob.slice(offsets[i], offsets[i+1])`. This makes every read a typed-array slice —
no parsing, no split. `streets` and `places` are additionally **sorted** so their own index doubles
as a binary-searchable prefix key (id = array index = sort position).

## `groups` (`kind: "groups-v1"`)

Struct-of-arrays, `count` rows:

```
streetId   : Uint32Array   index into streets[]
placeId    : Uint32Array   index into places[]
postcodeId : Uint32Array   index into places[] again (postcode reuses the places string table); 0xFFFFFFFF = none
centroidLat: Int32Array    1e-7 degrees, absolute (not delta)
centroidLon: Int32Array    1e-7 degrees, absolute
chunkId    : Uint32Array   which chunk section holds this group's address rows
rowOffset  : Uint32Array   first row index within that chunk
rowCount   : Uint32Array   number of contiguous rows for this group
```

Arrays are stored back-to-back in that field order, each length `count`, no interleaving — so a
consumer can view each field as its own typed array with one `byteOffset` math step. Groups are
sorted by `(streetId, placeId)` so all groups for a street are a contiguous range.

## `trigrams` (`kind: "trigram-postings-v1"`)

```
offset  size                field
0       4                   trigramCount : uint32
4       4*trigramCount      trigramKeys : Uint32Array, sorted ascending
                            (key = base-38 encoding of 3 chars: (code(a)*38 + code(b))*38 + code(c),
                             alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 #" — see
                             cli/src/pack/trigrams.ts TRIGRAM_ALPHABET / packTrigram)
4+4*trigramCount       4*trigramCount   postingOffsets : Uint32Array (index into postings, len trigramCount+1)
...                    postings : Uint32Array of streetId, sorted ascending within each trigram's range
```

Binary-search `trigramKeys` for a query trigram, then read `postings[postingOffsets[i] .. postingOffsets[i+1])`.

## `chunks` (`kind: "address-chunk-v1"`, one section per chunk, id `chunk:<n>`)

Each chunk is gzip'd independently (compressed:true) and holds a contiguous run of address rows
belonging to one or more groups (a chunk never splits a group). Decompressed layout, `count` rows:

```
number   : Uint32Array   house number, numeric part only
latD     : Int32Array    1e-7 degrees, delta from the OWNING GROUP's centroidLat
lonD     : Int32Array    1e-7 degrees, delta from the OWNING GROUP's centroidLon
unitRef  : Uint32Array   index into `units` string table; 0 = no unit
numExtra : Uint32Array   index into `numberExtra` string table; 0 = none (plain numeric number)
```

Rows within a group are sorted by `number` ascending so number resolution (PLAN.md §4.1 step 5) is
a binary search after the group's `[rowOffset, rowOffset+rowCount)` slice is located via the
group's `chunkId`.

## `cellDir` / `cellLists` (reverse index, PLAN.md §4.2)

Fixed grid, `cellSizeDeg` from the manifest (0.005 by default — ~550m N/S, ~460m E/W at 33°N).

```
latIdx(lat) = floor((lat + 90)  / cellSizeDeg)
lonIdx(lon) = floor((lon + 180) / cellSizeDeg)
LON_STEPS   = ceil(360 / cellSizeDeg)     // 72000 at 0.005°
cellKey     = latIdx * LON_STEPS + lonIdx  // fits Uint32: max ~36000*72000 = 2.592e9 < 2^32
```

`cellDir` (`kind: "cell-dir-v1"`), `count` occupied cells, sorted by `cellKey` ascending for binary
search / 9-neighbour lookup:

```
cellKeys     : Uint32Array (len count)
listOffsets  : Uint32Array (len count+1) — byte offsets into cellLists
```

`cellLists` (`kind: "cell-lists-v1"`) is one contiguous blob: for cell `i`,
`cellLists.slice(listOffsets[i], listOffsets[i+1])` is a **delta-varint** stream of ascending
**global address ordinals** (an address's position in a single logical concatenation of all chunks
in chunk order). A consumer turns an ordinal back into `(chunkId, rowOffset)` using each chunk's
`count` (carried in its section's manifest entry) and a running cumulative-sum — no extra index
needed, per PLAN.md §4.2.

Varint: standard LEB128 on `(delta)`, unsigned, since ordinals within one cell are stored sorted
ascending and delta-encoded from the previous ordinal in that cell's list (first entry is delta
from 0).

## Gazetteer container (version 2)

A **structurally different** manifest and section vocabulary for named-place (gazetteer) data —
e.g. USGS GNIS — sharing only the outer container framing (`magic`/`version`/`manifestLength`/
manifest JSON, then concatenated sections with byte ranges + checksums) with the address pack
above. `version` in the container header is `2` for every gazetteer pack; a reader must refuse
any file whose version it doesn't recognize, same as v1. An address pack and a gazetteer pack are
always separate files, loaded as separate datasets and merged at query time — there is no format
that mixes both kinds of section in one manifest.

### Manifest JSON shape

```ts
interface GazetteerManifest {
  version: 2;
  createdAt: string;        // ISO 8601
  region: string;
  sourceName: string;       // e.g. "USGS GNIS National File"
  recordCount: number;
  cellSizeDeg: number;      // independently configurable; geonames are far sparser than
                             // addresses, so the default (0.02°) is larger than v1's 0.005°
  sections: PackSection[];  // PackSection itself is unchanged from the v1 shape above
}
```

### `gnNames` / `gnNamesDisplay` (`kind: "string-table"`)

Same string-table codec as `streets`/`streetsDisplay` above. Sorted, deduped match-forms in
`gnNames` (array index = `nameId`); parallel first-seen display forms in `gnNamesDisplay`.

### `gnClasses` / `gnPlaces` (`kind: "string-table"`)

`gnClasses`: the distinct GNIS feature-class labels present (e.g. "Summit", "Stream"), in
first-seen order — no sort needed, there's no prefix-search use for this table. `gnPlaces`: county
and state values in one shared table, id `0` reserved as the "none" sentinel — same convention as
the address pack's `places` table.

### `gnRecords` (`kind: "gazetteer-chunk-v1"`, one section per chunk, id `gnChunk:<n>`)

Each chunk is gzip'd independently. Unlike the address pack's `chunks`, there is no group layer to
delta-encode against and no group-boundary constraint — a chunk is a fixed-size, arbitrary-split
run of records in original (post-dedup) order. Decompressed layout, `count` rows:

```
nameId   : Uint32Array   index into gnNames / gnNamesDisplay
classId  : Uint32Array   index into gnClasses
countyId : Uint32Array   index into gnPlaces
stateId  : Uint32Array   index into gnPlaces
lat      : Int32Array    1e-7 degrees, ABSOLUTE (no owning centroid to delta against)
lon      : Int32Array    1e-7 degrees, ABSOLUTE
```

A record's **global ordinal** (its position in the logical concatenation of all `gnChunk` sections
in order) is simply its index in the original records array, since chunk placement never
reshuffles records — `gnTrigrams` postings and `gnCellLists` entries both use this same ordinal
space directly, with no street->group->chunk indirection.

### `gnTrigrams` (`kind: "trigram-postings-v1"`)

Same codec as the address pack's `trigrams` section (see above), built over **every record's**
match-form (not the deduped `gnNames` table) — so postings resolve directly to a record's global
ordinal. A common name matching multiple distinct features (e.g. several "Bear Creek"s in
different counties) correctly returns all of them, each independently identifiable by its own
class/county/state.

### `gnCellDir` / `gnCellLists` (reverse index)

Same codec and cell-key math as the address pack's `cellDir`/`cellLists` above (`cellSizeDeg` from
this manifest, not the address pack's), storing global record ordinals per cell directly — there's
no chunk/group indirection to resolve through, since a record's ordinal already identifies which
`gnChunk` and row offset it lives at.

## Version history

- **v1** — initial format, this document (address packs).
- **v2** — gazetteer/place-name packs (this section). Wholly different manifest and section
  vocabulary from v1; shares only the outer container framing.
