/**
 * Street/place text normalization (PLAN.md §3.2). Shared, dependency-free, and used on BOTH
 * sides of the match: the CLI (`cli/src/ingest/normalize.ts`) canonicalizes street names at
 * pack-build time, and `lib/search/query-parse.ts` canonicalizes the user's query text the same
 * way at search time. They must never drift — that's why this lives here once, not twice.
 */

// USPS Publication 28 standard suffix abbreviations (subset covering common OpenAddresses values).
// Maps the CANONICAL short form -> the set of variants (including itself) that should collapse to it.
const SUFFIX_GROUPS: Record<string, string[]> = {
    ALY: ["ALLEY", "ALY", "ALLEE"],
    AVE: ["AVENUE", "AVE", "AV"],
    BLVD: ["BOULEVARD", "BLVD", "BOUL"],
    CIR: ["CIRCLE", "CIR", "CIRC"],
    CT: ["COURT", "CT"],
    CV: ["COVE", "CV"],
    CRES: ["CRESCENT", "CRES"],
    DR: ["DRIVE", "DR"],
    EXPY: ["EXPRESSWAY", "EXPY", "EXPWY"],
    HWY: ["HIGHWAY", "HWY"],
    LN: ["LANE", "LN"],
    LOOP: ["LOOP"],
    PARK: ["PARK", "PK"],
    PASS: ["PASS"],
    PATH: ["PATH"],
    PIKE: ["PIKE"],
    PKWY: ["PARKWAY", "PKWY", "PKY"],
    PL: ["PLACE", "PL"],
    PLZ: ["PLAZA", "PLZ"],
    PT: ["POINT", "PT"],
    RD: ["ROAD", "RD"],
    RUN: ["RUN"],
    SQ: ["SQUARE", "SQ"],
    ST: ["STREET", "ST", "STR"],
    TER: ["TERRACE", "TER", "TERR"],
    TRL: ["TRAIL", "TRL", "TR"],
    TPKE: ["TURNPIKE", "TPKE"],
    WAY: ["WAY", "WY"],
};

const DIRECTIONAL_GROUPS: Record<string, string[]> = {
    N: ["NORTH", "N"],
    S: ["SOUTH", "S"],
    E: ["EAST", "E"],
    W: ["WEST", "W"],
    NE: ["NORTHEAST", "NE"],
    NW: ["NORTHWEST", "NW"],
    SE: ["SOUTHEAST", "SE"],
    SW: ["SOUTHWEST", "SW"],
};

function buildLookup(groups: Record<string, string[]>): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const [canonical, variants] of Object.entries(groups)) {
        for (const variant of variants) lookup.set(variant, canonical);
    }
    return lookup;
}

const SUFFIX_LOOKUP = buildLookup(SUFFIX_GROUPS);
const DIRECTIONAL_LOOKUP = buildLookup(DIRECTIONAL_GROUPS);
const DIRECTIONAL_CANONICAL_FORMS = new Set(Object.keys(DIRECTIONAL_GROUPS));

/** Uppercase, strip punctuation to spaces, collapse whitespace. Does NOT canonicalize tokens. */
export function basicNormalize(input: string): string {
    return input
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Maps each already-uppercased token to its canonical directional/suffix short form. */
export function canonicalizeStreetTokens(tokens: readonly string[]): string[] {
    return tokens.map((tok) => DIRECTIONAL_LOOKUP.get(tok) ?? SUFFIX_LOOKUP.get(tok) ?? tok);
}

/**
 * Full match-form normalization for a street name: basic normalize, then canonicalize every
 * directional and suffix token to its short USPS form. "123 N Main Street" and "123 North Main
 * St" both produce "N MAIN ST".
 */
export function normalizeStreetForMatch(streetRaw: string): string {
    const basic = basicNormalize(streetRaw);
    if (!basic) return "";
    return canonicalizeStreetTokens(basic.split(" ")).join(" ");
}

/**
 * Display form: title-cases each word, but canonicalizes suffix/directional tokens to their
 * short form too (so results read "123 N Main St", not the source file's raw casing/spelling).
 * Directionals (N, NE, ...) stay fully uppercase per convention; everything else — including
 * suffix abbreviations like ST/AVE — is title-cased ("St", "Ave").
 */
export function normalizeStreetForDisplay(streetRaw: string): string {
    const matchForm = normalizeStreetForMatch(streetRaw);
    if (!matchForm) return "";
    return matchForm
        .split(" ")
        .map((tok) => (DIRECTIONAL_CANONICAL_FORMS.has(tok) ? tok : tok[0] + tok.slice(1).toLowerCase()))
        .join(" ");
}

export function normalizePlace(value: string): string {
    const basic = basicNormalize(value);
    if (!basic) return "";
    return basic
        .split(" ")
        .map((tok) => tok[0] + tok.slice(1).toLowerCase())
        .join(" ");
}

export function normalizePostcode(value: string): string {
    return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Splits a raw house-number string into a numeric part and a non-numeric remainder, per PLAN.md
 * §3.4 ("123A", "1/2" go to a side table). Returns null when there's no leading numeric run.
 */
export function splitHouseNumber(raw: string): { number: number; extra: string } | null {
    const trimmed = raw.trim();
    const match = /^(\d+)(.*)$/.exec(trimmed);
    if (!match) return null;
    const [, digits, rest] = match;
    return { number: Number.parseInt(digits!, 10), extra: rest!.trim() };
}

/**
 * Unicode NFD decomposition + strip combining marks — "Cañon" -> "Canon". `.toUpperCase()` does
 * NOT ASCII-fold accented Latin letters, so without this, `basicNormalize`'s punctuation strip
 * (`[^A-Z0-9\s]`) would blank an accented letter to a space instead — silently breaking trigram
 * matching for a name like "Cañon City" against a plain-ASCII typed query. Used for gazetteer
 * (place-name) matching, not street/place normalization above, which is USPS/ASCII by convention.
 */
export function foldDiacritics(value: string): string {
    return value.normalize("NFD").replace(/\p{Mark}/gu, "");
}

/**
 * Match-form for a gazetteer (place-name) record: diacritic-folded, then the same
 * uppercase/punctuation-strip/whitespace-collapse `basicNormalize` already does for streets. No
 * suffix/directional canonicalization — that's a street-address convention with no equivalent for
 * a mountain or stream name.
 */
export function normalizeGazetteerNameForMatch(nameRaw: string): string {
    return basicNormalize(foldDiacritics(nameRaw));
}

/**
 * Display form for a gazetteer record: sources like USGS GNIS already provide human-facing
 * casing and diacritics, so this only trims/collapses whitespace rather than re-casing the way
 * `normalizeStreetForDisplay` does for often-all-caps OpenAddresses street data.
 */
export function normalizeGazetteerNameForDisplay(nameRaw: string): string {
    return nameRaw.trim().replace(/\s+/g, " ");
}
