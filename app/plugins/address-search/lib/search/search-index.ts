/**
 * Ties together PLAN.md §4.1's forward-search pipeline: parse -> prefix path -> fuzzy fallback
 * -> group ranking -> number resolution -> unit collapsing. This is the class Phase 3's UI (and
 * Phase 6's cross-plugin contract) will call `search()`/`geocode()` on; Phase 2's job is proving
 * it's correct and fast against a real pack, via `bench/run.ts`, before any UI exists.
 */
import { getSection } from "../pack/container.ts";
import { decodeStringTable } from "../pack/strings.ts";
import { decodeGroups } from "../pack/groups.ts";
import { decodeTrigramPostings } from "../pack/trigrams.ts";
import { decodeCellDir } from "../pack/cells.ts";
import { directionVariants, parseQuery, placeSplits } from "./query-parse.ts";
import { prefixRange, streetIdsInRange } from "./prefix-search.ts";
import { trigramCandidateStreetIds, verifyFuzzyCandidates, MIN_FUZZY_QUERY_LENGTH } from "./fuzzy-search.ts";
import { rankGroups, type StreetMatch } from "./ranker.ts";
import { resolveNumber, collectUnitSiblings, type NumberResolution } from "./number-resolver.ts";
import { ChunkCache } from "./chunk-cache.ts";
import { haversineMeters } from "./distance.ts";
import {
    buildChunkFirstOrdinals,
    buildGroupsByChunk,
    candidateOrdinals,
    chunkForOrdinal,
    groupForRowOffset,
    type DecodedCellDir,
} from "./reverse-lookup.ts";
import type { PackSource } from "../pack/pack-source.ts";
import type { GeoPoint, ParsedQuery, SearchOptions, SearchResult, NumberMatchKind } from "./types.ts";
import type { DecodedGroup, PackManifest, TrigramPostings } from "../pack/types.ts";

/** Below this many prefix-path candidates, engage the fuzzy path too (PLAN.md §4.1 step 3). */
const MIN_CANDIDATES_BEFORE_FUZZY = 5;
const DEFAULT_LIMIT = 10;
/** "For the top ~10 groups only, read the chunk slice" — PLAN.md §4.1 step 5. */
const TOP_GROUPS_FOR_NUMBER_RESOLUTION = 10;

export class SearchIndex {
    private readonly source: PackSource;
    private readonly manifest: PackManifest;
    private readonly streets: readonly string[];
    private readonly streetsDisplay: readonly string[];
    private readonly places: readonly string[];
    private readonly units: readonly string[];
    private readonly numberExtras: readonly string[];
    private readonly groups: readonly DecodedGroup[];
    private readonly trigrams: TrigramPostings;
    private readonly chunkCache: ChunkCache;
    /** Resident per PLAN.md §3.3 — the small cell directory, plus the two derived indices Phase 5
     *  needs to turn a `cellLists` ordinal back into an address (see lib/search/reverse-lookup.ts). */
    private readonly cellDir: DecodedCellDir;
    private readonly chunkFirstOrdinals: readonly number[];
    private readonly groupsByChunk: ReadonlyMap<number, DecodedGroup[]>;

    // Plain field assignment, not constructor parameter properties — see the note in
    // lib/pack/pack-source.ts's constructor for why (Node's native TS execution can't strip them).
    private constructor(
        source: PackSource,
        manifest: PackManifest,
        streets: readonly string[],
        streetsDisplay: readonly string[],
        places: readonly string[],
        units: readonly string[],
        numberExtras: readonly string[],
        groups: readonly DecodedGroup[],
        trigrams: TrigramPostings,
        chunkCache: ChunkCache,
        cellDir: DecodedCellDir,
    ) {
        this.source = source;
        this.manifest = manifest;
        this.streets = streets;
        this.streetsDisplay = streetsDisplay;
        this.places = places;
        this.units = units;
        this.numberExtras = numberExtras;
        this.groups = groups;
        this.trigrams = trigrams;
        this.chunkCache = chunkCache;
        this.cellDir = cellDir;
        this.chunkFirstOrdinals = buildChunkFirstOrdinals(manifest);
        this.groupsByChunk = buildGroupsByChunk(groups);
    }

    static async open(source: PackSource): Promise<SearchIndex> {
        const manifest = await source.manifest();
        const [streetsBuf, streetsDisplayBuf, placesBuf, unitsBuf, numberExtraBuf, groupsBuf, trigramsBuf, cellDirBuf] =
            await Promise.all([
                source.readSection("streets"),
                source.readSection("streetsDisplay"),
                source.readSection("places"),
                source.readSection("units"),
                source.readSection("numberExtra"),
                source.readSection("groups"),
                source.readSection("trigrams"),
                source.readSection("cellDir"),
            ]);

        return new SearchIndex(
            source,
            manifest,
            decodeStringTable(streetsBuf),
            decodeStringTable(streetsDisplayBuf),
            decodeStringTable(placesBuf),
            decodeStringTable(unitsBuf),
            decodeStringTable(numberExtraBuf),
            decodeGroups(groupsBuf, getSection(manifest, "groups").count!),
            decodeTrigramPostings(trigramsBuf),
            new ChunkCache(source, manifest),
            decodeCellDir(cellDirBuf, getSection(manifest, "cellDir").count!),
        );
    }

    async search(rawQuery: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
        const parsed = parseQuery(rawQuery);

        const readings = [parsed, ...placeSplits(parsed)];

        for (const reading of readings) {
            const results = await this.searchParsed(reading, opts);
            if (results.length > 0) return results;
        }

        for (const reading of readings) {
            const results = await this.searchWithDirections(reading, opts);
            if (results.length > 0) return results;
        }
        return [];
    }

    /**
     * Every direction of the street at once, since "10th St, Springfield" may mean N or S 10th St. Fuzzy
     * hits are dropped: with a guessed direction, they'd offer "W 11th St" for a town with no W 10th St.
     */
    private async searchWithDirections(reading: ParsedQuery, opts: SearchOptions): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        for (const variant of directionVariants(reading)) {
            const found = await this.searchParsed(variant, opts);
            results.push(...found.filter((result) => result.matchedVia !== "fuzzy"));
        }

        results.sort((a, b) => b.score - a.score
            || (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY));
        return results.slice(0, opts.limit ?? DEFAULT_LIMIT);
    }

    private async searchParsed(parsed: ParsedQuery, opts: SearchOptions): Promise<SearchResult[]> {
        if (!parsed.streetQuery) return [];

        const streetMatches = this.matchStreets(parsed.streetQuery);
        if (streetMatches.length === 0) return [];

        const limit = opts.limit ?? DEFAULT_LIMIT;
        const ranked = rankGroups(this.groups, streetMatches, {
            places: this.places,
            placeHint: parsed.placeHint,
            postcodeHint: parsed.postcodeHint,
            reference: opts.reference,
            limit: Math.max(limit, TOP_GROUPS_FOR_NUMBER_RESOLUTION),
        });

        const results: SearchResult[] = [];
        for (const candidate of ranked) {
            if (results.length >= limit) break;

            const rows = await this.chunkCache.getRows(candidate.group.chunkId);
            const resolved = resolveNumber(rows, candidate.group, parsed.number);
            if (!resolved) continue;
            const { representative, unitList } = collectUnitSiblings(rows, candidate.group, resolved, this.units);

            const streetDisplay = this.streetsDisplay[candidate.streetMatch.streetId] ?? "";
            const city = this.places[candidate.group.placeId] ?? "";
            const postcode = this.places[candidate.group.postcodeId] ?? "";
            const numberExtra = this.numberExtras[representative.numExtra] ?? "";

            results.push({
                displayAddress: this.formatDisplayAddress(representative.number, numberExtra, streetDisplay, city, postcode),
                lat: candidate.group.centroidLatE7 / 1e7 + representative.latD / 1e7,
                lon: candidate.group.centroidLonE7 / 1e7 + representative.lonD / 1e7,
                number: representative.number,
                numberExtra,
                streetDisplay,
                city,
                postcode,
                units: unitList,
                matchedVia: candidate.streetMatch.tier,
                numberMatchedVia: resolved.matchedVia,
                score: this.scoreFor(candidate.streetMatch, resolved.matchedVia),
                distanceMeters: candidate.distanceMeters,
            });
        }
        return results;
    }

    /**
     * PLAN.md §4.2: the nearest address to a clicked point, or `undefined` if nothing is found
     * within `MAX_REVERSE_LOOKUP_RADIUS` cells (rural areas with no data nearby). `cellLists` is
     * fetched fresh per call rather than kept resident — see lib/search/reverse-lookup.ts's own
     * doc comment for why that matches this storage layer's actual read granularity.
     */
    async reverseLookup(point: GeoPoint): Promise<SearchResult | undefined> {
        const cellListsBlob = await this.source.readSection("cellLists");
        const ordinals = candidateOrdinals(point.lat, point.lon, this.manifest.cellSizeDeg, this.cellDir, cellListsBlob);
        if (ordinals.length === 0) return undefined;

        let best: { result: SearchResult; distanceMeters: number } | undefined;
        for (const ordinal of ordinals) {
            const chunkId = chunkForOrdinal(this.chunkFirstOrdinals, ordinal);
            const rowOffset = ordinal - this.chunkFirstOrdinals[chunkId]!;
            const groupsInChunk = this.groupsByChunk.get(chunkId);
            const group = groupsInChunk && groupForRowOffset(groupsInChunk, rowOffset);
            // Only reachable with a malformed pack (an ordinal with no owning group) — degrade
            // rather than throw, same convention as the rest of this class's chunk/group handling.
            if (!group) continue;

            const rows = await this.chunkCache.getRows(chunkId);
            const row = rows[rowOffset];
            if (!row) continue;

            const lat = group.centroidLatE7 / 1e7 + row.latD / 1e7;
            const lon = group.centroidLonE7 / 1e7 + row.lonD / 1e7;
            const distanceMeters = haversineMeters(point, { lat, lon });
            if (best && distanceMeters >= best.distanceMeters) continue;

            const resolution: NumberResolution = { row, rowIndex: rowOffset, matchedVia: "exact" };
            const { representative, unitList } = collectUnitSiblings(rows, group, resolution, this.units);
            const streetDisplay = this.streetsDisplay[group.streetId] ?? "";
            const city = this.places[group.placeId] ?? "";
            const postcode = this.places[group.postcodeId] ?? "";
            const numberExtra = this.numberExtras[representative.numExtra] ?? "";

            best = {
                distanceMeters,
                result: {
                    displayAddress: this.formatDisplayAddress(representative.number, numberExtra, streetDisplay, city, postcode),
                    lat: group.centroidLatE7 / 1e7 + representative.latD / 1e7,
                    lon: group.centroidLonE7 / 1e7 + representative.lonD / 1e7,
                    number: representative.number,
                    numberExtra,
                    streetDisplay,
                    city,
                    postcode,
                    units: unitList,
                    matchedVia: "reverse",
                    numberMatchedVia: "exact",
                    score: 100,
                    distanceMeters,
                },
            };
        }
        return best?.result;
    }

    private matchStreets(streetQuery: string): StreetMatch[] {
        const prefixIds = streetIdsInRange(prefixRange(this.streets, streetQuery));
        const streetMatches: StreetMatch[] = prefixIds.map((id) => ({
            streetId: id,
            tier: this.streets[id] === streetQuery ? "exact" : "prefix",
            editDistance: 0,
        }));

        // An exact match means the user typed the correct spelling — never go looking for
        // near-miss alternatives in that case, or a query like "123 Main St" (exact) would also
        // surface "N Main St" as a spurious fuzzy hit (edit distance 2 for inserting "N ").
        const hasExactMatch = streetMatches.some((m) => m.tier === "exact");
        if (!hasExactMatch && prefixIds.length < MIN_CANDIDATES_BEFORE_FUZZY && streetQuery.length >= MIN_FUZZY_QUERY_LENGTH) {
            const alreadyMatched = new Set(prefixIds);
            const candidateIds = trigramCandidateStreetIds(streetQuery, this.trigrams).filter((id) => !alreadyMatched.has(id));
            const fuzzy = verifyFuzzyCandidates(streetQuery, candidateIds, this.streets);
            for (const match of fuzzy) {
                streetMatches.push({ streetId: match.streetId, tier: "fuzzy", editDistance: match.distance });
            }
        }
        return streetMatches;
    }

    private formatDisplayAddress(number: number, numberExtra: string, streetDisplay: string, city: string, postcode: string): string {
        // manifest.region is a free-text CLI label (e.g. "AZ" or "AZ-Coconino"), not a guaranteed
        // 2-letter postal abbreviation — good enough for a display string, not a data guarantee.
        const houseAndStreet = [`${number}${numberExtra}`, streetDisplay].filter(Boolean).join(" ");
        const cityState = [city, this.manifest.region].filter(Boolean).join(" ");
        return [houseAndStreet, [cityState, postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    }

    private scoreFor(streetMatch: StreetMatch, numberMatchedVia: NumberMatchKind): number {
        const tierScore =
            streetMatch.tier === "exact" ? 100 : streetMatch.tier === "prefix" ? 70 : 40 - streetMatch.editDistance * 5;
        return tierScore - (numberMatchedVia === "nearest" ? 10 : 0);
    }
}
