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
