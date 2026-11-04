<template>
    <div class='address-search-bar'>
        <div class='address-search-bar__row'>
            <input
                ref='inputEl'
                v-model='query'
                type='text'
                class='address-search-bar__input'
                placeholder='Search address...'
                @keydown.esc='close'
            >
            <div
                role='button'
                tabindex='0'
                class='address-search-bar__icon-btn'
                :class='{ "address-search-bar__icon-btn--active": reverseArmed }'
                title='Click the map for the nearest address'
                @click='toggleReverseLookup'
            >
                <IconCrosshair
                    :size='18'
                    stroke='2'
                />
            </div>
            <div
                role='button'
                tabindex='0'
                class='address-search-bar__icon-btn'
                title='Datasets'
                @click='menuOpen = !menuOpen'
            >
                <IconDatabase
                    :size='18'
                    stroke='2'
                />
            </div>
            <div
                role='button'
                tabindex='0'
                class='address-search-bar__icon-btn'
                title='Settings'
                @click='openGear'
            >
                <IconSettings
                    :size='18'
                    stroke='2'
                />
            </div>
            <div
                role='button'
                tabindex='0'
                class='address-search-bar__icon-btn'
                title='Help'
                @click='openHelp'
            >
                <IconHelpCircle
                    :size='18'
                    stroke='2'
                />
            </div>
            <div
                role='button'
                tabindex='0'
                class='address-search-bar__icon-btn'
                title='Close'
                @click='close'
            >
                <IconX
                    :size='18'
                    stroke='2'
                />
            </div>
        </div>

        <div
            v-if='managedStatus'
            class='address-search-bar__status'
        >
            Updating {{ managedStatus.label }}{{ managedStatus.packTotal > 1 ? ` (${managedStatus.packIndex} of ${managedStatus.packTotal})` : '' }}…
            {{ managedStatus.sectionsDone }}/{{ managedStatus.sectionsTotal }}
        </div>

        <div
            v-if='menuOpen'
            class='address-search-bar__panel'
        >
            <div
                v-if='datasets.length === 0 && isAdmin'
                class='address-search-bar__empty-row'
                role='button'
                tabindex='0'
                @click='openGear'
            >
                No datasets loaded — click to add one
            </div>
            <div
                v-else-if='datasets.length === 0'
                class='address-search-bar__empty-row'
            >
                Address data downloads automatically the next time this device is online.
            </div>
            <label
                v-for='dataset in datasets'
                :key='dataset.datasetId'
                class='address-search-bar__dataset-row'
            >
                <input
                    type='checkbox'
                    :checked='dataset.enabled'
                    @change='onToggleDataset(dataset.datasetId, $event)'
                >
                {{ dataset.label }} <span class='address-search-bar__muted'>({{ datasetCount(dataset).toLocaleString() }})</span>
            </label>
        </div>

        <div
            v-if='results.length > 0'
            class='address-search-bar__panel'
        >
            <template
                v-for='(result, i) in results'
                :key='i'
            >
                <div class='address-search-bar__result-row'>
                    <div
                        role='button'
                        tabindex='0'
                        class='address-search-bar__result-main'
                        @click='selectResult(result)'
                    >
                        <div>{{ result.displayAddress }}</div>
                        <div
                            v-if='result.units.length > 0'
                            class='address-search-bar__muted'
                        >
                            Units: {{ result.units.join(', ') }}
                        </div>
                    </div>
                    <div
                        role='button'
                        tabindex='0'
                        class='address-search-bar__icon-btn'
                        title='Drop marker'
                        @click='dropOpenIndex = dropOpenIndex === i ? null : i'
                    >
                        <IconMapPinPlus
                            :size='18'
                            stroke='2'
                        />
                    </div>
                </div>
                <AddressSearchDropPrompt
                    v-if='dropOpenIndex === i'
                    :result='result'
                    @close='dropOpenIndex = null'
                />
            </template>
        </div>
        <div
            v-else-if='searched && query.trim().length > 0'
            class='address-search-bar__panel'
        >
            <div class='address-search-bar__empty-row'>
                No matches
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconCrosshair, IconDatabase, IconHelpCircle, IconMapPinPlus, IconSettings, IconX } from '@tabler/icons-vue';
import type { MapMouseEvent } from 'maplibre-gl';
import { api, close, datasetsVersion, isAdmin, managedStatus, pinia, workerClient } from '../lib/state.ts';
import { gpsReference, isCoreDrawActive } from '../lib/core-bridge.ts';
import { listDatasets, setEnabled } from '../lib/storage/dataset-store.ts';
import { syncManifestKv } from '../lib/manifest-sync.ts';
import type { DatasetRecord } from '../lib/storage/schema.ts';
import type { SearchResult } from '../lib/search/types.ts';
import AddressSearchGear from './AddressSearchGear.vue';
import AddressSearchHelp from './AddressSearchHelp.vue';
import AddressSearchDropPrompt from './AddressSearchDropPrompt.vue';

const GEAR_FLOAT_UID = 'address-search-gear';
const HELP_FLOAT_UID = 'address-search-help';
const DEBOUNCE_MS = 90;

const query = ref('');
const results = ref<SearchResult[]>([]);
const searched = ref(false);
const menuOpen = ref(false);
const datasets = ref<DatasetRecord[]>([]);
const inputEl = ref<HTMLInputElement | null>(null);
const dropOpenIndex = ref<number | null>(null);
const reverseArmed = ref(false);

let debounceHandle: ReturnType<typeof setTimeout> | null = null;

/** Phase 8: a gazetteer dataset counts places, not addresses — same branch as AddressSearchGear.vue. */
function datasetCount(dataset: DatasetRecord): number {
    return dataset.kind === "gazetteer" ? dataset.recordCount : dataset.addressCount;
}

async function refreshDatasets(): Promise<void> {
    try {
        datasets.value = await listDatasets();
    } catch (err) {
        console.warn('[address-search] failed to list datasets', err);
    }
}

async function onToggleDataset(datasetId: string, event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    await setEnabled(datasetId, checked);
    await workerClient.value?.refresh();
    await refreshDatasets();
    void syncManifestKv();
}

function mapCenterFallback(): { lat: number; lon: number } | undefined {
    try {
        const center = api.value?.map.getCenter();
        return center ? { lat: center.lat, lon: center.lng } : undefined;
    } catch {
        return undefined;
    }
}

async function runSearch(): Promise<void> {
    dropOpenIndex.value = null;
    const q = query.value.trim();
    if (!q) {
        results.value = [];
        searched.value = false;
        return;
    }
    const reference = (pinia.value ? gpsReference(pinia.value) : undefined) ?? mapCenterFallback();
    try {
        results.value = (await workerClient.value?.search(q, { reference, limit: 8 })) ?? [];
    } catch (err) {
        console.warn('[address-search] search failed', err);
        results.value = [];
    }
    searched.value = true;
}

watch(datasetsVersion, () => void refreshDatasets());

watch(query, () => {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(runSearch, DEBOUNCE_MS);
});

function selectResult(result: SearchResult): void {
    // Decision #5: selecting a result pans/zooms only — dropping a marker is the separate,
    // explicit per-row action (the pin+ button, opening AddressSearchDropPrompt).
    api.value?.map.flyTo({ center: [result.lon, result.lat], zoom: 17 });
    close();
}

/**
 * PLAN.md §4.2: reverse-lookup mode is a one-shot arm, never a standing listener — arming attaches
 * a single `click` handler that fires once and immediately detaches itself, which is also the main
 * mitigation for click contention with other plugins (there's no way to detect a sibling plugin's
 * own active state — see `isCoreDrawActive()`'s own doc comment).
 */
function toggleReverseLookup(): void {
    if (reverseArmed.value) disarmReverseLookup();
    else armReverseLookup();
}

function armReverseLookup(): void {
    const map = api.value?.map;
    if (!map) return;
    reverseArmed.value = true;
    map.getCanvas().style.cursor = 'crosshair';
    map.on('click', handleReverseClick);
}

function disarmReverseLookup(): void {
    reverseArmed.value = false;
    const map = api.value?.map;
    if (!map) return;
    map.off('click', handleReverseClick);
    map.getCanvas().style.cursor = '';
}

async function handleReverseClick(e: MapMouseEvent): Promise<void> {
    const point = { lat: e.lngLat.lat, lon: e.lngLat.lng };
    disarmReverseLookup();
    dropOpenIndex.value = null;
    try {
        const hit = await workerClient.value?.reverseLookup(point);
        results.value = hit ? [hit] : [];
    } catch (err) {
        console.warn('[address-search] reverse lookup failed', err);
        results.value = [];
    }
    searched.value = true;
}

// Mutual exclusion with core's own Drawing Tools (PLAN.md §10) — mirrors the exact pattern
// ~/dev/cloudtak-plugin-measure/components/MeasureToggle.vue uses against the same signal.
watch(
    () => (pinia.value ? isCoreDrawActive(pinia.value) : false),
    (coreActive) => {
        if (coreActive && reverseArmed.value) disarmReverseLookup();
    },
);

onBeforeUnmount(() => {
    // The bar itself unmounts when the toggle button collapses it — never leave a dangling map
    // click listener or a stuck crosshair cursor behind.
    if (reverseArmed.value) disarmReverseLookup();
});

function openGear(): void {
    if (!api.value) return;
    api.value.float.add({
        uid: GEAR_FLOAT_UID,
        name: 'Address Search Settings',
        component: AddressSearchGear,
        width: 420,
        height: 480,
    });
}

function openHelp(): void {
    if (!api.value) return;
    api.value.float.add({
        uid: HELP_FLOAT_UID,
        name: 'Address Search Help',
        component: AddressSearchHelp,
        width: 380,
        height: 460,
    });
}

onMounted(() => {
    void refreshDatasets();
    inputEl.value?.focus();
});
</script>

<style scoped>
.address-search-bar {
    display: flex;
    flex-direction: column;
    width: 100%;
}
.address-search-bar__row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
}
.address-search-bar__input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    outline: none;
    padding: 4px 6px;
}
.address-search-bar__icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    cursor: pointer;
    flex-shrink: 0;
    border-radius: 4px;
}
.address-search-bar__icon-btn:hover {
    background-color: rgba(128, 128, 128, 0.2);
}
.address-search-bar__icon-btn--active {
    background-color: rgba(60, 140, 255, 0.35);
}
.address-search-bar__panel {
    max-height: 260px;
    overflow-y: auto;
    border-top: 1px solid var(--tblr-border-color, rgba(128, 128, 128, 0.3));
}
.address-search-bar__empty-row,
.address-search-bar__dataset-row {
    padding: 6px 10px;
    cursor: pointer;
}
.address-search-bar__result-row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px 0 10px;
}
.address-search-bar__result-main {
    flex: 1;
    min-width: 0;
    padding: 6px 0;
    cursor: pointer;
}
.address-search-bar__result-main:hover {
    opacity: 0.85;
}
.address-search-bar__dataset-row {
    display: flex;
    align-items: center;
    gap: 6px;
}
.address-search-bar__muted {
    opacity: 0.65;
    font-size: 0.85em;
}
.address-search-bar__status {
    padding: 2px 8px;
    font-size: 0.8em;
    opacity: 0.75;
}
</style>
