/**
 * cloudtak-plugin-address-search — public cross-plugin contract (docs/PLAN.md §6).
 *
 * This file is the published API: a consumer plugin copies it into its own repo for type safety.
 * There is no package registry in this ecosystem, so "published" means source-level, the same way
 * docs/HOSTING.md documents a recommendation rather than shipping infrastructure.
 *
 * Plugins never import each other's internals — only CloudTAK core's — so this contract is data
 * (a `db.kv` manifest) plus a runtime handle (a `window` global), never an import of this repo's
 * `lib/`. Both are absent whenever this plugin isn't installed, isn't enabled, or has been
 * disabled — always check before use; see docs/CROSS_PLUGIN_API.md for the usage pattern.
 */

/** One matched or geocoded address. A trimmed projection of this plugin's own internal
 *  `SearchResult` — ranking diagnostics (how the match was found, its internal score) are
 *  deliberately not part of the public contract, so they can change freely without breaking it. */
export interface AddressSearchResult {
    displayAddress: string;
    lat: number;
    lon: number;
    number: number;
    numberExtra: string;
    streetDisplay: string;
    city: string;
    postcode: string;
    /** Sibling unit strings collapsed to this base address (e.g. apartment/suite numbers). */
    units: string[];
    /** Straight-line distance in meters from the search's reference point, or `null` if none was given. */
    distanceMeters: number | null;
    /**
     * Present (`"gazetteer"`) for a place-name hit (mountains, streams, populated places — from a
     * loaded USGS GNIS-derived dataset); absent for a street-address hit. Every address-only field
     * above (`number`, `numberExtra`, `streetDisplay`, `city`, `postcode`, `units`) is left at its
     * honest empty default on a gazetteer hit rather than repurposed to hold place data — use
     * `featureClass`/`county`/`state` instead for that case.
     */
    sourceKind?: "address" | "gazetteer";
    /** Set only when `sourceKind === "gazetteer"` — e.g. "Summit", "Stream", "Populated Place". */
    featureClass?: string;
    county?: string;
    state?: string;
}

/** One loaded dataset's public summary — everything internal (the full pack manifest, storage
 *  status, etc.) is deliberately omitted. */
export interface AddressSearchManifestDataset {
    label: string;
    region: string;
    enabled: boolean;
    kind: "address" | "gazetteer";
    /** Present when `kind === "address"`. */
    addressCount?: number;
    /** Present when `kind === "gazetteer"`. */
    recordCount?: number;
}

/**
 * The shape of `db.kv['addresssearch:manifest']`'s JSON string value. Read it with CloudTAK
 * core's own `KV.value('addresssearch:manifest')` or, reactively, `KV.liveFrom(...)` — this lets a
 * consumer know what's loaded (or that nothing is) without calling into this plugin at all.
 */
export interface AddressSearchManifest {
    version: 1;
    /** ISO 8601 timestamp of the last time a dataset was added, removed, or toggled. */
    updatedAt: string;
    datasets: AddressSearchManifestDataset[];
}

/**
 * The runtime lookup API, registered at `window['addresssearch:api']` only while this plugin is
 * enabled. Both methods degrade to an empty/`undefined` result rather than throwing on an internal
 * failure — a consumer should still treat the global's absence entirely (plugin not installed or
 * not yet enabled) as the primary thing to check for.
 */
export interface AddressSearchApi {
    /** Full-text address search, same pipeline the plugin's own search bar uses. */
    search(query: string, opts?: { limit?: number; reference?: { lat: number; lon: number } }): Promise<AddressSearchResult[]>;
    /** Convenience wrapper over `search()` returning just the single best match, if any. */
    geocode(addressString: string): Promise<AddressSearchResult | undefined>;
}

declare global {
    interface Window {
        "addresssearch:api"?: AddressSearchApi;
    }
}
