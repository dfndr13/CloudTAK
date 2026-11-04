export interface GeoPoint {
    lat: number;
    lon: number;
}

export interface SearchOptions {
    /** GPS fix, or map-center fallback, for distance ranking (PLAN.md §4.1 step 4 / decision #11). */
    reference?: GeoPoint;
    limit?: number;
}

export type MatchKind = "exact" | "prefix" | "fuzzy";
export type NumberMatchKind = "exact" | "nearest";

export interface SearchResult {
    displayAddress: string;
    lat: number;
    lon: number;
    number: number;
    numberExtra: string;
    streetDisplay: string;
    city: string;
    postcode: string;
    /** Sibling unit strings at this base address (PLAN.md §3.3/decision #12 — units collapse to the base address). */
    units: string[];
    /** `"reverse"` (Phase 5) means this came from a click-on-map lookup, not text matching — kept
     *  separate from `MatchKind` itself since that type is shared with `StreetMatch.tier`, where
     *  "reverse" would never apply (see `lib/search/ranker.ts`'s exhaustive `TIER_ORDER`). */
    matchedVia: MatchKind | "reverse";
    numberMatchedVia: NumberMatchKind;
    /** Higher is better. Internal ranking score, not meant for display. */
    score: number;
    distanceMeters: number | null;
    /** Set by `GazetteerIndex` (Phase 8) to `"gazetteer"` for a place-name hit; absent (meaning
     *  `"address"`) for every existing `SearchIndex`-produced result — widened, not replaced, same
     *  approach as `matchedVia`'s `"reverse"` addition in Phase 5. Every address-only field above
     *  (`number`, `numberExtra`, `streetDisplay`, `city`, `postcode`, `units`) is left at its
     *  honest empty default on a gazetteer hit rather than repurposed to hold place data. */
    sourceKind?: "address" | "gazetteer";
    /** Set only when `sourceKind === "gazetteer"` — e.g. "Summit", "Stream". */
    featureClass?: string;
    county?: string;
    state?: string;
}

export interface ParsedQuery {
    number: number | null;
    /** Canonicalized street tokens joined by spaces — may be a partial/prefix. */
    streetQuery: string;
    placeHint: string | null;
    postcodeHint: string | null;
}
