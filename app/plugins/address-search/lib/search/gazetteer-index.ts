/**
 * Phase 8: the gazetteer (place-name) sibling of `SearchIndex`. Deliberately simpler — no group
 * layer, no lazy per-chunk cache. A gazetteer pack is small enough (tens of thousands to a few
 * million records, per the CLI's own default chunk-row-budget behavior) to decode fully at
 * `open()` and keep resident, so a resolved ordinal is just a direct index into flat arrays —
 * see this repo's Phase 8 plan for the sizing reasoning. Every generic search primitive below is
 * reused unmodified from the address path; only the resident-data shape and result-building are
 * new.
 */
import { gunzip, getSection } from "../pack/container.ts";
import { decodeStringTable } from "../pack/strings.ts";
import { decodeTrigramPostings } from "../pack/trigrams.ts";
import { decodeCellDir } from "../pack/cells.ts";
import { decodeGazetteerChunkRows } from "../pack/gazetteer-chunks.ts";
import { normalizeGazetteerNameForMatch } from "../normalize.ts";
import { prefixRange, streetIdsInRange } from "./prefix-search.ts";
import { trigramCandidateStreetIds, verifyFuzzyCandidates, MIN_FUZZY_QUERY_LENGTH } from "./fuzzy-search.ts";
import { candidateOrdinals, type DecodedCellDir } from "./reverse-lookup.ts";
import { haversineMeters } from "./distance.ts";
import type { PackSource } from "../pack/pack-source.ts";
import type { GeoPoint, SearchOptions, SearchResult } from "./types.ts";
import type { GazetteerManifest, TrigramPostings } from "../pack/types.ts";

const MIN_CANDIDATES_BEFORE_FUZZY = 5;
const DEFAULT_LIMIT = 10;

interface NameCandidate {
    ordinal: number;
    tier: "exact" | "prefix" | "fuzzy";
    editDistance: number;
}

export class GazetteerIndex {
    private readonly source: PackSource<GazetteerManifest>;
    private readonly manifest: GazetteerManifest;
    private readonly names: readonly string[];
    private readonly namesDisplay: readonly string[];
    private readonly classes: readonly string[];
    private readonly places: readonly string[];
    private readonly trigrams: TrigramPostings;
    private readonly cellDir: DecodedCellDir;
    /** Every record, fully resident — see this file's own doc comment for why. Ordinal = array
     *  index, since chunk placement never reorders records (cli/src/pack/gazetteer-chunks.ts). */
    private readonly nameId: Uint32Array;
    private readonly classId: Uint32Array;
    private readonly countyId: Uint32Array;
    private readonly stateId: Uint32Array;
    private readonly latE7: Int32Array;
    private readonly lonE7: Int32Array;
    private readonly recordOrdinalsByNameId: ReadonlyMap<number, number[]>;

    private constructor(
        source: PackSource<GazetteerManifest>,
        manifest: GazetteerManifest,
        names: readonly string[],
        namesDisplay: readonly string[],
        classes: readonly string[],
        places: readonly string[],
        trigrams: TrigramPostings,
        cellDir: DecodedCellDir,
        nameId: Uint32Array,
        classId: Uint32Array,
        countyId: Uint32Array,
        stateId: Uint32Array,
        latE7: Int32Array,
        lonE7: Int32Array,
    ) {
        this.source = source;
        this.manifest = manifest;
        this.names = names;
        this.namesDisplay = namesDisplay;
        this.classes = classes;
        this.places = places;
        this.trigrams = trigrams;
        this.cellDir = cellDir;
        this.nameId = nameId;
        this.classId = classId;
        this.countyId = countyId;
        this.stateId = stateId;
        this.latE7 = latE7;
        this.lonE7 = lonE7;

        const byNameId = new Map<number, number[]>();
        for (let ordinal = 0; ordinal < nameId.length; ordinal++) {
            const id = nameId[ordinal]!;
            let list = byNameId.get(id);
            if (!list) {
                list = [];
                byNameId.set(id, list);
            }
            list.push(ordinal);
        }
        this.recordOrdinalsByNameId = byNameId;
    }

    static async open(source: PackSource<GazetteerManifest>): Promise<GazetteerIndex> {
        const manifest = await source.manifest();
        const [namesBuf, namesDisplayBuf, classesBuf, placesBuf, trigramsBuf, cellDirBuf] = await Promise.all([
            source.readSection("gnNames"),
            source.readSection("gnNamesDisplay"),
            source.readSection("gnClasses"),
            source.readSection("gnPlaces"),
            source.readSection("gnTrigrams"),
            source.readSection("gnCellDir"),
        ]);

        const chunkSections = manifest.sections
            .filter((s) => s.id.startsWith("gnChunk:"))
            .sort((a, b) => Number(a.id.slice("gnChunk:".length)) - Number(b.id.slice("gnChunk:".length)));

        const recordCount = manifest.recordCount;
        const nameId = new Uint32Array(recordCount);
        const classId = new Uint32Array(recordCount);
        const countyId = new Uint32Array(recordCount);
        const stateId = new Uint32Array(recordCount);
        const latE7 = new Int32Array(recordCount);
        const lonE7 = new Int32Array(recordCount);

        let cursor = 0;
        for (const section of chunkSections) {
            const compressed = await source.readSection(section.id);
            const raw = section.compressed ? await gunzip(compressed) : compressed;
            const rows = decodeGazetteerChunkRows(raw, section.count!);
            for (const row of rows) {
                nameId[cursor] = row.nameId;
                classId[cursor] = row.classId;
                countyId[cursor] = row.countyId;
                stateId[cursor] = row.stateId;
                latE7[cursor] = row.latE7;
                lonE7[cursor] = row.lonE7;
                cursor++;
            }
        }

        return new GazetteerIndex(
            source,
            manifest,
            decodeStringTable(namesBuf),
            decodeStringTable(namesDisplayBuf),
            decodeStringTable(classesBuf),
            decodeStringTable(placesBuf),
            decodeTrigramPostings(trigramsBuf),
            decodeCellDir(cellDirBuf, getSection(manifest, "gnCellDir").count!),
            nameId,
            classId,
            countyId,
            stateId,
            latE7,
            lonE7,
        );
    }

    async search(rawQuery: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
        const query = normalizeGazetteerNameForMatch(rawQuery);
        if (!query) return [];

        const candidates = this.matchCandidates(query);
        if (candidates.length === 0) return [];

        const limit = opts.limit ?? DEFAULT_LIMIT;
        const ranked = candidates
            .map((c) => ({ ...c, distanceMeters: opts.reference ? haversineMeters(opts.reference, this.pointFor(c.ordinal)) : null }))
            .sort((a, b) => {
                const tierOrder = { exact: 2, prefix: 1, fuzzy: 0 } as const;
                const tierDiff = tierOrder[b.tier] - tierOrder[a.tier];
                if (tierDiff !== 0) return tierDiff;
                if (a.tier === "fuzzy" && a.editDistance !== b.editDistance) return a.editDistance - b.editDistance;
                return (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY);
            })
            .slice(0, limit);

        return ranked.map((c) => this.buildResult(c.ordinal, c.tier, c.editDistance, c.distanceMeters));
    }

    /** Nearest named place to a clicked point, or `undefined` if nothing is within range. Mirrors
     *  `SearchIndex.reverseLookup()`'s "fetch cellLists fresh per call" pattern; unlike the address
     *  case there's no chunk/group resolution step — a candidate ordinal already indexes the fully
     *  resident arrays directly. */
    async reverseLookup(point: GeoPoint): Promise<SearchResult | undefined> {
        const cellListsBlob = await this.source.readSection("gnCellLists");
        const ordinals = candidateOrdinals(point.lat, point.lon, this.manifest.cellSizeDeg, this.cellDir, cellListsBlob);
        if (ordinals.length === 0) return undefined;

        let best: { ordinal: number; distanceMeters: number } | undefined;
        for (const ordinal of ordinals) {
            const distanceMeters = haversineMeters(point, this.pointFor(ordinal));
            if (!best || distanceMeters < best.distanceMeters) best = { ordinal, distanceMeters };
        }
        if (!best) return undefined;
        return this.buildResult(best.ordinal, "reverse", 0, best.distanceMeters);
    }

    private matchCandidates(query: string): NameCandidate[] {
        const { start, end } = prefixRange(this.names, query);
        const prefixNameIds = streetIdsInRange({ start, end });
        const candidates: NameCandidate[] = [];
        const seenOrdinals = new Set<number>();

        for (const nameId of prefixNameIds) {
            const tier = this.names[nameId] === query ? "exact" : "prefix";
            for (const ordinal of this.recordOrdinalsByNameId.get(nameId) ?? []) {
                seenOrdinals.add(ordinal);
                candidates.push({ ordinal, tier, editDistance: 0 });
            }
        }

        const hasExactMatch = candidates.some((c) => c.tier === "exact");
        if (!hasExactMatch && candidates.length < MIN_CANDIDATES_BEFORE_FUZZY && query.length >= MIN_FUZZY_QUERY_LENGTH) {
            // gnTrigrams' postings are already per-record ordinals (Phase 7's own design), so a
            // trigram hit resolves directly — no nameId indirection needed for this path.
            const recordMatchForms = new Array<string>(this.nameId.length);
            const fuzzyCandidateOrdinals = trigramCandidateStreetIds(query, this.trigrams).filter((id) => !seenOrdinals.has(id));
            for (const ordinal of fuzzyCandidateOrdinals) recordMatchForms[ordinal] = this.names[this.nameId[ordinal]!] ?? "";
            const fuzzy = verifyFuzzyCandidates(query, fuzzyCandidateOrdinals, recordMatchForms);
            for (const match of fuzzy) {
                candidates.push({ ordinal: match.streetId, tier: "fuzzy", editDistance: match.distance });
            }
        }
        return candidates;
    }

    private pointFor(ordinal: number): GeoPoint {
        return { lat: this.latE7[ordinal]! / 1e7, lon: this.lonE7[ordinal]! / 1e7 };
    }

    private buildResult(
        ordinal: number,
        tier: "exact" | "prefix" | "fuzzy" | "reverse",
        editDistance: number,
        distanceMeters: number | null,
    ): SearchResult {
        const nameDisplay = this.namesDisplay[this.nameId[ordinal]!] ?? "";
        const featureClass = this.classes[this.classId[ordinal]!] ?? "";
        const county = this.places[this.countyId[ordinal]!] ?? "";
        const state = this.places[this.stateId[ordinal]!] ?? "";
        const { lat, lon } = this.pointFor(ordinal);
        const score = tier === "exact" || tier === "reverse" ? 100 : tier === "prefix" ? 70 : 40 - editDistance * 5;

        return {
            displayAddress: [nameDisplay, [featureClass, county, state].filter(Boolean).join(", ")].filter(Boolean).join(" — "),
            lat,
            lon,
            number: 0,
            numberExtra: "",
            streetDisplay: "",
            city: "",
            postcode: "",
            units: [],
            matchedVia: tier,
            numberMatchedVia: "exact",
            score,
            distanceMeters,
            sourceKind: "gazetteer",
            featureClass,
            county,
            state,
        };
    }
}
