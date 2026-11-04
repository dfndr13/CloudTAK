/**
 * Every reach into CloudTAK core internals that `PluginAPI` (`../../plugin.ts`) doesn't cover,
 * isolated to this one file per the measure plugin's convention (docs/PLAN.md §9.1/§10) — one
 * file carries all the rebase risk, and every accessor degrades instead of throwing so a core
 * rename doesn't take the whole plugin down with it.
 *
 * GPS for ranking (PLAN.md §4.1 step 4, decision #11 — "nearest to GPS first; automatic fallback
 * to map center when there is no fix"), the Phase 4 drop-marker write path, Phase 5's core-draw
 * mutual exclusion, and Phase 6's `db.kv` manifest publish all live here — none of them are
 * covered by `PluginAPI` (only `map`, `feature.list/stream`, neither of which covers location
 * state, writes, `DrawTool.mode`, or `db.kv`).
 */
import type { Pinia } from "pinia";
import { useMapStore } from "../../../src/stores/map.ts";
import KV from "../../../src/base/kv.ts";
import type { GeoPoint } from "./search/types.ts";

/** The cross-plugin contract's namespaced `db.kv` key (PLAN.md §6) — kept here rather than in
 *  lib/manifest-sync.ts since it's the literal string passed to a core import. */
export const MANIFEST_KV_KEY = "addresssearch:manifest";

/** Core's own contact/channel/mission share dialog — re-exported here rather than imported
 *  directly from a component, per PLAN.md §9.1's rule that every deep core reach (including a
 *  component one) is confined to this one file. Takes `feats?: Feature[]` and mounts via
 *  `api.float.add({ component: ShareModal, props: { feats: [...] } })`. */
export { default as ShareModal } from "../../../src/components/CloudTAK/util/Share.vue";

/** Default point type when core exposes none — same fallback core itself uses
 *  (`api/web/src/stores/map.ts:220`). */
const DEFAULT_POINT_TYPE = "u-d-p";

enum LocationStateMirror {
    Loading = 0,
    Disabled = 1,
    Preset = 2,
    Live = 3,
}

interface MapStoreLocationFields {
    location?: number;
    locationAccuracy?: number;
    gpsCoordinates?: { lat: number; lng: number } | null;
}

/**
 * The user's current GPS fix as a ranking reference point, or `undefined` when there is none
 * (no fix yet, or location is explicitly disabled) — callers fall back to the map's own center in
 * that case, per decision #11. Note the map store's own field is `lng`, not `lon`; this is the
 * one place that gets translated to this plugin's `GeoPoint` shape.
 */
export function gpsReference(pinia: Pinia): GeoPoint | undefined {
    try {
        const mapStore = useMapStore(pinia) as unknown as MapStoreLocationFields;
        if (mapStore.location === LocationStateMirror.Disabled) return undefined;
        const coords = mapStore.gpsCoordinates;
        if (!coords) return undefined;
        return { lat: coords.lat, lon: coords.lng };
    } catch (err) {
        console.warn("[address-search] failed to read GPS coordinates from map store", err);
        return undefined;
    }
}

/**
 * The user's own default point type preference (Settings -> profile `tak_type`, surfaced on the
 * map store as `defaultPointType`), so the Phase 4 drop-marker prompt starts from the same default
 * CloudTAK itself already uses rather than a plugin-invented one. Degrades to `'u-d-p'` (core's
 * own fallback, `api/web/src/stores/map.ts:220`) if the field isn't there.
 */
export function defaultPointType(pinia: Pinia): string {
    try {
        const mapStore = useMapStore(pinia) as unknown as { defaultPointType?: string };
        return mapStore.defaultPointType || DEFAULT_POINT_TYPE;
    } catch (err) {
        console.warn("[address-search] failed to read default point type from map store", err);
        return DEFAULT_POINT_TYPE;
    }
}

export interface DropMarkerOptions {
    point: GeoPoint;
    callsign: string;
    /** A CoT point type, or the `'u-d-p'` custom-point sentinel — see `defaultPointType()`. */
    pointType: string;
    /** `false` is genuinely local — profile-only, never filed to an active Mission, never touches
     *  the network (PLAN.md §8.5). `true` files into the active Mission if one exists. */
    authored: boolean;
}

/** The written feature, in the shape core itself reads/writes (loosely typed at this boundary —
 *  same convention as the `add()` cast below — good enough structurally for `ShareModal`'s
 *  `feats: Feature[]` prop without coupling to core's own `Feature` type). */
export type DroppedFeature = Record<string, unknown>;

/**
 * Writes a dropped address-search result as a real CoT point feature. Mirrors the exact shape
 * core's own "Draw Point" tool produces (`api/web/src/stores/modules/draw.ts:401-440`) — same
 * `how`/`stale`/`marker-*` properties — so the result is indistinguishable from a core-drawn point
 * for icon rendering, Mission sync, and everything else downstream, rather than inventing a new
 * shape. Returns the written feature (so callers can hand it straight to `ShareModal`), or
 * `undefined` if the write wasn't possible.
 */
export async function dropMarker(pinia: Pinia, opts: DropMarkerOptions): Promise<DroppedFeature | undefined> {
    try {
        const mapStore = useMapStore(pinia);
        const store = mapStore as unknown as {
            worker?: {
                db?: {
                    add?: (feat: Record<string, unknown>, opts: { authored: boolean }) => Promise<unknown>;
                };
            };
            refresh?: () => Promise<void>;
        };

        if (typeof store.worker?.db?.add !== "function") return undefined;

        const id = crypto.randomUUID();
        const now = new Date();
        const properties: Record<string, unknown> = {
            id,
            type: opts.pointType,
            how: "h-g-i-g-o",
            archived: true,
            callsign: opts.callsign,
            time: now.toISOString(),
            start: now.toISOString(),
            stale: new Date(now.getTime() + 3600).toISOString(),
            center: [0, 0],
            "marker-opacity": 1,
        };
        if (opts.pointType === DEFAULT_POINT_TYPE) {
            properties["marker-color"] = "#00FF00";
        }

        const feat: DroppedFeature = {
            id,
            type: "Feature",
            path: "/",
            properties,
            geometry: {
                type: "Point",
                coordinates: [opts.point.lon, opts.point.lat],
            },
        };

        await store.worker.db.add(feat, { authored: opts.authored });

        if (typeof store.refresh === "function") await store.refresh();

        return feat;
    } catch (err) {
        console.error("[address-search] failed to drop marker", err);
        return undefined;
    }
}

/** Mirrors core's own `DrawToolMode.STATIC` (`api/web/src/stores/modules/draw.ts:36`) — the value
 *  `DrawTool.mode` holds when core isn't drawing anything. */
const CORE_DRAW_STATIC_MODE = "static";

/**
 * Is CloudTAK's own Drawing Tools surface currently active? Reads `DrawTool.mode`, a `ref` behind
 * a getter, so this is reactive and safe inside a Vue `watch`/`computed` — exactly the pattern
 * `~/dev/cloudtak-plugin-measure/lib/core-bridge.ts`'s `isCoreDrawActive()` already uses for its
 * own mutual exclusion against core draw. Duplicated here rather than imported, since plugins
 * never import each other's internals — only core's, one at a time.
 *
 * PLAN.md §4.2/§10: reverse-lookup mode must stand down the instant core's own draw activates.
 * There is no equivalent signal for "another plugin (e.g. measure) is active" — its own toggle
 * state is a private module singleton, not exposed anywhere — so this covers exactly what §10's
 * own risk mitigation scopes to, matching what measure itself relies on for the same problem.
 * Returns `false` if the field is missing — a missing field must never make reverse-lookup think
 * core drawing is permanently active.
 */
export function isCoreDrawActive(pinia: Pinia): boolean {
    try {
        const mapStore = useMapStore(pinia) as unknown as { draw?: { mode?: string } };
        const mode = mapStore.draw?.mode;
        if (typeof mode !== "string") return false;
        return mode !== CORE_DRAW_STATIC_MODE;
    } catch (err) {
        console.warn("[address-search] failed to read core draw mode", err);
        return false;
    }
}

/**
 * Publishes the Phase 6 cross-plugin manifest (PLAN.md §6) to CloudTAK's own `db.kv`, under
 * `MANIFEST_KV_KEY`. Unlike every other function in this file, `KV`'s static methods talk to the
 * shared Dexie `db` directly and need no `pinia`/`mapStore` at all — still belongs here rather
 * than in lib/manifest-sync.ts since it's the one place doing the actual `../../../src/...` reach.
 */
export async function writeManifestKv(json: string): Promise<void> {
    try {
        await KV.update(MANIFEST_KV_KEY, json);
    } catch (err) {
        console.error("[address-search] failed to publish cross-plugin manifest", err);
    }
}

/** Removes the manifest key on `disable()` — the mechanism that makes "consumers degrade
 *  gracefully when the key is absent" (PLAN.md §6) actually true once this plugin is turned off. */
export async function deleteManifestKv(): Promise<void> {
    try {
        await KV.delete(MANIFEST_KV_KEY);
    } catch (err) {
        console.warn("[address-search] failed to remove cross-plugin manifest", err);
    }
}

/** `db.kv` key for the shared "default dataset" one-click config — whatever URL/label whoever
 *  configures it in the gear panel sets, so every OTHER user sees a one-click "Load <label>"
 *  option the first time they open the search bar with nothing loaded yet, instead of needing to
 *  know or paste a URL themselves. */
const DEFAULT_PACK_KV_KEY = "addresssearch:default-pack";

export interface DefaultPackConfig {
    url: string;
    label: string;
}

/**
 * Reads the shared default-dataset config, or `undefined` if none is set (or the stored value is
 * malformed — degrade to "no default" rather than throw, so a bad value never blocks the rest of
 * the UI). There is no admin/permission check here — `PluginAPI` exposes no role information at
 * all, so this is readable and, in `writeDefaultPackConfig()`, writable by any user with the gear
 * panel open. The gear panel's own label makes clear this setting is shared instance-wide, so a
 * well-intentioned user knows the consequence, but nothing here can enforce who's allowed to set
 * it.
 */
export async function readDefaultPackConfig(): Promise<DefaultPackConfig | undefined> {
    try {
        const raw = await KV.value(DEFAULT_PACK_KV_KEY);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<DefaultPackConfig>;
        if (typeof parsed.url !== "string" || typeof parsed.label !== "string" || !parsed.url.trim()) return undefined;
        return { url: parsed.url, label: parsed.label };
    } catch (err) {
        console.warn("[address-search] failed to read default pack config", err);
        return undefined;
    }
}

export async function writeDefaultPackConfig(config: DefaultPackConfig): Promise<void> {
    try {
        await KV.update(DEFAULT_PACK_KV_KEY, JSON.stringify(config));
    } catch (err) {
        console.error("[address-search] failed to save default pack config", err);
    }
}

export async function clearDefaultPackConfig(): Promise<void> {
    try {
        await KV.delete(DEFAULT_PACK_KV_KEY);
    } catch (err) {
        console.warn("[address-search] failed to clear default pack config", err);
    }
}
