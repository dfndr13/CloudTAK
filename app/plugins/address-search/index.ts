/**
 * CloudTAK Address Search plugin — local-first address search over an OpenAddresses-derived
 * pack, with an optional online fallback. See docs/PLAN.md for the full phased plan; all 7 phases
 * are built as of Phase 6 (docs/cross-plugin-api.d.ts / docs/CROSS_PLUGIN_API.md).
 */
import type { App } from 'vue';
import type { PluginAPI, PluginInstance } from '../../plugin.ts';
import * as state from './lib/state.ts';
import { SearchWorkerClient } from './lib/worker/worker-client.ts';
import { syncManifestKv } from './lib/manifest-sync.ts';
import { deleteManifestKv } from './lib/core-bridge.ts';
import { syncManagedPacks } from './lib/managed-packs.ts';
import AddressSearchToggle from './components/AddressSearchToggle.vue';
import type { SearchOptions, SearchResult } from './lib/search/types.ts';

const BOTTOM_BAR_KEY = 'address-search';
/** PLAN.md §6's "namespaced id" for the runtime lookup API — same naming style as the `db.kv`
 *  manifest key (lib/core-bridge.ts's `MANIFEST_KV_KEY`), just on `window` instead of `db.kv`,
 *  since a live callable can't be stored as a `db.kv` string. See docs/cross-plugin-api.d.ts. */
const WINDOW_API_KEY = 'addresssearch:api';
/** Same-origin pack list published by the CloudTAK operator next to the .pack files. */
const PACK_LIST_PATH = '/address-packs/packs.json';
/** Long-open tabs (vehicle laptops) re-check the list this often, so updates still arrive. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** Trims lib/search/types.ts's internal SearchResult down to the public contract (docs/
 *  cross-plugin-api.d.ts's AddressSearchResult) — explicitly listing fields rather than
 *  destructuring-to-discard the internal-only ones (matchedVia/numberMatchedVia/score, ranking
 *  diagnostics a consumer has no use for) so nothing here reads as an unused local. */
function toPublicResult(result: SearchResult) {
    return {
        displayAddress: result.displayAddress,
        lat: result.lat,
        lon: result.lon,
        number: result.number,
        numberExtra: result.numberExtra,
        streetDisplay: result.streetDisplay,
        city: result.city,
        postcode: result.postcode,
        units: result.units,
        distanceMeters: result.distanceMeters,
        // Phase 8: present (sourceKind: "gazetteer") for a place-name hit, absent for an address
        // hit — same widen-don't-replace approach as internal SearchResult itself.
        sourceKind: result.sourceKind,
        featureClass: result.featureClass,
        county: result.county,
        state: result.state,
    };
}

export default class AddressSearchPlugin implements PluginInstance {
    api: PluginAPI;
    private recheckTimer: ReturnType<typeof setInterval> | null = null;
    private adminSub: { unsubscribe(): void } | null = null;
    private syncing = false;
    private readonly onOnline = (): void => void this.syncPacks();

    constructor(api: PluginAPI) {
        this.api = api;
    }

    static async install(_app: App, api: PluginAPI): Promise<PluginInstance> {
        return new AddressSearchPlugin(api);
    }

    async enable(): Promise<void> {
        state.pinia.value = this.api.pinia;
        state.api.value = this.api;

        try {
            state.workerClient.value = new SearchWorkerClient();
        } catch (err) {
            console.error('[address-search] failed to start search worker', err);
            return;
        }

        this.api.bottomBar.add({ key: BOTTOM_BAR_KEY, component: AddressSearchToggle });

        // PLAN.md §6: publish the cross-plugin contract. Registered here (not module scope) so
        // it only exists while the plugin is actually enabled, matching bottomBar/worker lifecycle.
        (window as unknown as Record<string, unknown>)[WINDOW_API_KEY] = {
            search: async (query: string, opts?: SearchOptions) => {
                const results = (await state.workerClient.value?.search(query, opts)) ?? [];
                return results.map(toPublicResult);
            },
            geocode: async (addressString: string) => {
                const results = (await state.workerClient.value?.search(addressString, { limit: 1 })) ?? [];
                return results[0] ? toPublicResult(results[0]) : undefined;
            },
        };
        void syncManifestKv();

        // Streamed, not read once: the profile may not have synced yet when the plugin starts.
        this.adminSub = this.api.profile.stream('system_admin').subscribe({
            next: (admin) => { state.isAdmin.value = admin === true; },
            error: () => { state.isAdmin.value = false; },
        });

        window.addEventListener('online', this.onOnline);
        this.recheckTimer = setInterval(() => void this.syncPacks(), RECHECK_MS);
        void this.syncPacks();
    }

    /** Installs/updates/removes server-managed packs. Offline (or list unreachable) = no change. */
    private async syncPacks(): Promise<void> {
        if (!navigator.onLine || this.syncing) return;
        this.syncing = true;
        try {
            const result = await syncManagedPacks({
                listUrl: new URL(PACK_LIST_PATH, window.location.origin).toString(),
                onProgress: (p) => {
                    state.managedStatus.value = {
                        label: p.label,
                        packIndex: p.packIndex,
                        packTotal: p.packTotal,
                        sectionsDone: p.sectionsDone,
                        sectionsTotal: p.sectionsTotal,
                    };
                },
            });
            if (result.status === 'ok') {
                for (const f of result.failed) console.warn(`[address-search] pack ${f.id} failed to load: ${f.error}`);
                if (result.installed.length > 0 || result.removed.length > 0) {
                    await state.workerClient.value?.refresh();
                    state.datasetsVersion.value++;
                    void syncManifestKv();
                }
            } else if (result.status === 'unavailable') {
                console.warn(`[address-search] pack list unavailable, nothing changed: ${result.reason}`);
            }
        } catch (err) {
            console.error('[address-search] managed pack sync failed', err);
        } finally {
            state.managedStatus.value = null;
            this.syncing = false;
        }
    }

    async disable(): Promise<void> {
        window.removeEventListener('online', this.onOnline);
        if (this.recheckTimer) clearInterval(this.recheckTimer);
        this.recheckTimer = null;
        this.adminSub?.unsubscribe();
        this.adminSub = null;
        state.isAdmin.value = false;
        this.api.bottomBar.remove(BOTTOM_BAR_KEY);

        delete (window as unknown as Record<string, unknown>)[WINDOW_API_KEY];
        void deleteManifestKv();

        state.workerClient.value?.terminate();
        state.workerClient.value = null;
        state.expanded.value = false;
        state.api.value = null;
        state.pinia.value = null;
    }
}
