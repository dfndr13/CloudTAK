/**
 * PLAN.md §4.1 step 1: leading digits -> house number; a bare 5-digit trailing token ->
 * postcode; text after a comma -> place hint; remainder -> street tokens (canonicalized the same
 * way ingest-time street names are, via `lib/normalize.ts`, so "N" matches "NORTH").
 */
import { basicNormalize, canonicalizeStreetTokens, normalizePlace } from "../normalize.ts";
import type { ParsedQuery } from "./types.ts";

const POSTCODE_RE = /^\d{5}$/;
const LEADING_NUMBER_RE = /^\d+$/;

export function parseQuery(raw: string): ParsedQuery {
    const commaIdx = raw.indexOf(",");
    const mainPart = commaIdx >= 0 ? raw.slice(0, commaIdx) : raw;
    const placeHintRaw = commaIdx >= 0 ? raw.slice(commaIdx + 1).trim() : "";

    const tokens = basicNormalize(mainPart).split(" ").filter(Boolean);

    let number: number | null = null;
    if (tokens.length > 0 && LEADING_NUMBER_RE.test(tokens[0]!)) {
        number = Number.parseInt(tokens.shift()!, 10);
    }

    let postcodeHint: string | null = null;
    if (tokens.length > 1 && POSTCODE_RE.test(tokens[tokens.length - 1]!)) {
        postcodeHint = tokens.pop()!;
    }

    const streetQuery = canonicalizeStreetTokens(tokens).join(" ");
    const placeHint = placeHintRaw ? normalizePlace(placeHintRaw) : null;

    return { number, streetQuery, placeHint, postcodeHint };
}

/** How many trailing words of a comma-less query may be a town and state ("Oak Grove St"). */
const MAX_TRAILING_PLACE_TOKENS = 3;

/**
 * Other readings of a comma-less query, for when it matched nothing as written: "N 10th St Springfield St"
 * read as street "N 10TH ST" in "Springfield St". Fewest place words first; empty if the query had a comma.
 */
export function placeSplits(parsed: ParsedQuery): ParsedQuery[] {
    if (parsed.placeHint) return [];

    const tokens = parsed.streetQuery.split(" ").filter(Boolean);
    const splits: ParsedQuery[] = [];
    for (let count = 1; count <= MAX_TRAILING_PLACE_TOKENS && count < tokens.length; count++) {
        splits.push({
            ...parsed,
            streetQuery: tokens.slice(0, -count).join(" "),
            placeHint: normalizePlace(tokens.slice(-count).join(" ")),
        });
    }
    return splits;
}

/** The canonical forms `canonicalizeStreetTokens` gives street directions. */
const STREET_DIRECTIONS = ["N", "S", "E", "W", "NE", "NW", "SE", "SW"];

/**
 * The query with each street direction in front, for when it matched nothing without one: streets
 * are stored as "N 10TH ST", which a search for "10TH ST" can't reach. Empty if it already has one.
 */
export function directionVariants(parsed: ParsedQuery): ParsedQuery[] {
    const first = parsed.streetQuery.split(" ")[0]!;
    if (!first || STREET_DIRECTIONS.includes(first)) return [];

    return STREET_DIRECTIONS.map((direction) => ({ ...parsed, streetQuery: `${direction} ${parsed.streetQuery}` }));
}
