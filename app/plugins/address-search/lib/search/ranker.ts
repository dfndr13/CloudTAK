/**
 * PLAN.md §4.1 step 4: gather groups for the matched streets, filter by place/postcode hint if
 * present, rank by (textScore, distanceFromGPS). Distance uses the group centroid, already
 * resident — no chunk read required to rank.
 */
import { haversineMeters } from "./distance.ts";
import type { DecodedGroup } from "../pack/types.ts";
import type { GeoPoint, MatchKind } from "./types.ts";

export interface StreetMatch {
    streetId: number;
    tier: MatchKind;
    /** 0 for exact/prefix; the verified Damerau-Levenshtein distance for fuzzy. */
    editDistance: number;
}

export interface RankedGroupCandidate {
    group: DecodedGroup;
    streetMatch: StreetMatch;
    distanceMeters: number | null;
}

const TIER_ORDER: Record<MatchKind, number> = { exact: 2, prefix: 1, fuzzy: 0 };

function groupRangeForStreet(groups: readonly DecodedGroup[], streetId: number): { start: number; end: number } {
    // groups[] is sorted primarily by streetId (docs/PACK_FORMAT.md), so its range is contiguous.
    let lo = 0;
    let hi = groups.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (groups[mid]!.streetId < streetId) lo = mid + 1;
        else hi = mid;
    }
    const start = lo;
    hi = groups.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (groups[mid]!.streetId <= streetId) lo = mid + 1;
        else hi = mid;
    }
    return { start, end: lo };
}

function groupCentroid(group: DecodedGroup): GeoPoint {
    return { lat: group.centroidLatE7 / 1e7, lon: group.centroidLonE7 / 1e7 };
}

export interface RankOptions {
    places: readonly string[];
    placeHint: string | null;
    postcodeHint: string | null;
    reference?: GeoPoint;
    limit: number;
}

export function rankGroups(
    groups: readonly DecodedGroup[],
    streetMatches: readonly StreetMatch[],
    opts: RankOptions,
): RankedGroupCandidate[] {
    const { places, placeHint, postcodeHint, reference, limit } = opts;
    const candidates: RankedGroupCandidate[] = [];

    for (const streetMatch of streetMatches) {
        const { start, end } = groupRangeForStreet(groups, streetMatch.streetId);
        for (let i = start; i < end; i++) {
            const group = groups[i]!;

            if (placeHint) {
                const place = places[group.placeId] ?? "";
                const hint = placeHint.toUpperCase();
                const name = place.toUpperCase();
                // Second test: the hint carries more than the town ("Salina Ks 67401", "Salina Usa").
                if (!name.startsWith(hint) && !(name && hint.startsWith(`${name} `))) continue;
            }
            if (postcodeHint) {
                const postcode = places[group.postcodeId] ?? "";
                if (postcode !== postcodeHint) continue;
            }

            const distanceMeters = reference ? haversineMeters(reference, groupCentroid(group)) : null;
            candidates.push({ group, streetMatch, distanceMeters });
        }
    }

    candidates.sort((a, b) => {
        const tierDiff = TIER_ORDER[b.streetMatch.tier] - TIER_ORDER[a.streetMatch.tier];
        if (tierDiff !== 0) return tierDiff;
        if (a.streetMatch.tier === "fuzzy" && a.streetMatch.editDistance !== b.streetMatch.editDistance) {
            return a.streetMatch.editDistance - b.streetMatch.editDistance;
        }
        return (a.distanceMeters ?? Number.POSITIVE_INFINITY) - (b.distanceMeters ?? Number.POSITIVE_INFINITY);
    });

    return candidates.slice(0, limit);
}
