<template>
    <MenuTemplate
        name='Cam Depot'
        :loading='false'
    >
        <template #buttons>
            <button
                type='button'
                class='btn btn-sm btn-outline-secondary'
                title='Sync: check the camera catalog for changes and reload'
                :disabled='state.loading || state.syncing'
                @click='sync'
            >
                <span
                    v-if='state.loading || state.syncing'
                    class='spinner-border spinner-border-sm me-1'
                />
                Sync
            </button>
        </template>

        <template #default>
            <div class='col-12 px-2 py-2 d-flex flex-column gap-2'>
                <TablerToggle
                    v-model='state.visible'
                    label='Show cameras on the map'
                />

                <div class='d-flex align-items-center gap-2'>
                    <span class='form-label mb-0'>States</span>
                    <button
                        type='button'
                        class='btn btn-sm flex-grow-1 text-truncate justify-content-start'
                        :title='pickedLabel'
                        @click='picking = !picking'
                    >
                        <span
                            class='text-truncate'
                            v-text='pickedLabel'
                        />
                        <IconChevronUp
                            v-if='picking'
                            class='ms-auto flex-shrink-0'
                            :size='16'
                            stroke='1.5'
                        />
                        <IconChevronDown
                            v-else
                            class='ms-auto flex-shrink-0'
                            :size='16'
                            stroke='1.5'
                        />
                    </button>
                </div>

                <div
                    v-if='picking'
                    class='border rounded p-2 d-flex flex-column gap-1'
                >
                    <TablerInput
                        v-model='placeFilter'
                        icon='search'
                        placeholder='Find a state or province'
                    />
                    <div class='small text-secondary'>
                        {{ pickedCount.toLocaleString() }} cameras selected
                        <span v-if='pickedCount > BIG_SELECTION'>: a big selection can make the map slow</span>
                    </div>
                    <div class='cam-place-list'>
                        <template
                            v-for='group in placeGroups'
                            :key='group.label'
                        >
                            <div
                                v-if='group.items.length'
                                class='small fw-bold text-secondary mt-1'
                                v-text='group.label'
                            />
                            <label
                                v-for='s in group.items'
                                :key='s.id'
                                class='form-check mb-0'
                            >
                                <input
                                    class='form-check-input'
                                    type='checkbox'
                                    :checked='state.states.includes(s.id)'
                                    @change='togglePlace(s.id)'
                                >
                                <span class='form-check-label'>
                                    {{ s.name }}
                                    <span
                                        v-if='s.cameras'
                                        class='text-secondary'
                                    >({{ s.cameras.toLocaleString() }})</span>
                                </span>
                            </label>
                        </template>
                    </div>
                    <button
                        type='button'
                        class='btn btn-sm btn-primary'
                        @click='picking = false'
                    >
                        Done
                    </button>
                </div>

                <TablerInput
                    v-model='filter'
                    icon='search'
                    placeholder='Search cameras'
                />

                <TablerToggle
                    v-model='state.onScreen'
                    label='On screen only'
                />

                <TablerToggle
                    v-model='state.favoritesOnly'
                    :label='`Favorites only (${state.favorites.length})`'
                />

                <div
                    v-if='!state.favoritesOnly'
                    class='d-flex flex-column gap-2'
                >
                    <div class='d-flex align-items-center gap-2'>
                        <span class='form-label mb-0 cam-label'>Show</span>
                        <select
                            v-model='state.kind'
                            class='form-select form-select-sm'
                        >
                            <option value='all'>
                                Every camera
                            </option>
                            <option value='video'>
                                Live video
                            </option>
                            <option value='still'>
                                Picture only
                            </option>
                            <option value='fire'>
                                Fire cameras
                            </option>
                            <option value='offline'>
                                Offline
                            </option>
                        </select>
                    </div>

                    <div class='d-flex align-items-center gap-2'>
                        <span class='form-label mb-0 cam-label'>Provider</span>
                        <select
                            v-model='state.provider'
                            class='form-select form-select-sm'
                        >
                            <option value=''>
                                All providers
                            </option>
                            <option
                                v-for='p in providerOptions'
                                :key='p.id'
                                :value='p.id'
                                v-text='`${p.id} (${p.count.toLocaleString()})`'
                            />
                        </select>
                    </div>

                    <div class='d-flex align-items-center gap-2'>
                        <span class='form-label mb-0 cam-label'>Counties</span>
                        <button
                            type='button'
                            class='btn btn-sm flex-grow-1 text-truncate justify-content-start'
                            @click='pickingCounties = !pickingCounties'
                        >
                            <span
                                class='text-truncate'
                                v-text='countiesLabel'
                            />
                            <IconChevronUp
                                v-if='pickingCounties'
                                class='ms-auto flex-shrink-0'
                                :size='16'
                                stroke='1.5'
                            />
                            <IconChevronDown
                                v-else
                                class='ms-auto flex-shrink-0'
                                :size='16'
                                stroke='1.5'
                            />
                        </button>
                    </div>

                    <div
                        v-if='pickingCounties'
                        class='border rounded p-2 d-flex flex-column gap-1'
                    >
                        <TablerInput
                            v-model='countyFilter'
                            icon='search'
                            placeholder='Find a county'
                        />
                        <div class='cam-place-list'>
                            <label
                                v-for='c in countyOptions'
                                :key='c.key'
                                class='form-check mb-0'
                            >
                                <input
                                    class='form-check-input'
                                    type='checkbox'
                                    :checked='state.counties.includes(c.key)'
                                    @change='toggleCounty(c.key)'
                                >
                                <span class='form-check-label'>
                                    {{ c.label }}
                                    <span class='text-secondary'>({{ c.count.toLocaleString() }})</span>
                                </span>
                            </label>
                        </div>
                        <div class='d-flex gap-2'>
                            <button
                                type='button'
                                class='btn btn-sm flex-grow-1'
                                :disabled='!state.counties.length'
                                @click='state.counties = []'
                            >
                                All counties
                            </button>
                            <button
                                type='button'
                                class='btn btn-sm btn-primary flex-grow-1'
                                @click='pickingCounties = false'
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>

                <div
                    v-if='state.syncNote'
                    class='small text-secondary'
                    v-text='state.syncNote'
                />

                <div
                    v-if='view.limited && state.visible'
                    class='small text-secondary'
                >
                    {{ view.total.toLocaleString() }} cameras match, so the map shows the {{ view.drawn.toLocaleString() }}
                    nearest the view. Pan or zoom to see others.
                </div>

                <div class='small text-secondary d-flex gap-3'>
                    <span><span class='cam-dot cam-dot-video' /> Video {{ counts.video }}</span>
                    <span><span class='cam-dot cam-dot-still' /> Picture only {{ counts.still }}</span>
                    <span v-if='counts.offline'><span class='cam-dot cam-dot-offline' /> Offline {{ counts.offline }}</span>
                </div>
            </div>

            <TablerAlert
                v-if='state.error'
                :err='new Error(state.error)'
            />
            <template v-else-if='state.favoritesOnly'>
                <TablerNone
                    v-if='!favoriteRows.length'
                    label='No favorites yet: tap the star on a camera'
                    :create='false'
                />
                <div
                    v-else
                    class='list-group list-group-flush'
                >
                    <div
                        v-for='fav in favoriteRows'
                        :key='fav.id'
                        class='list-group-item d-flex align-items-center gap-2 px-2 py-2 cursor-pointer hover'
                        role='button'
                        tabindex='0'
                        @click='openFavorite(fav)'
                        @keyup.enter='openFavorite(fav)'
                    >
                        <div class='flex-grow-1 text-truncate'>
                            <div
                                class='text-truncate'
                                :title='fav.name'
                                v-text='fav.name'
                            />
                            <div
                                class='small text-secondary text-truncate'
                                v-text='`${fav.provider}, ${fav.state}`'
                            />
                        </div>
                        <TablerIconButton
                            title='Remove from favorites'
                            @click.stop='removeFavorite(fav.id)'
                        >
                            <IconStarFilled
                                :size='20'
                                class='text-yellow'
                            />
                        </TablerIconButton>
                    </div>
                </div>
            </template>
            <TablerLoading
                v-else-if='state.loading && !state.cameras.length'
                desc='Loading cameras'
            />
            <TablerNone
                v-else-if='!shown.length'
                :label='searchWords.length ? "No match in your picked states" : "No cameras match"'
                :create='false'
            />
            <div
                v-else
                class='list-group list-group-flush'
            >
                <div
                    v-for='cam in shown'
                    :key='cam.id'
                    class='list-group-item d-flex align-items-center gap-2 px-2 py-2 cursor-pointer hover'
                    role='button'
                    tabindex='0'
                    @click='goTo(cam)'
                    @keyup.enter='goTo(cam)'
                >
                    <span :class='["cam-dot", !cam.online ? "cam-dot-offline" : (cam.video ? "cam-dot-video" : "cam-dot-still")]' />
                    <div class='flex-grow-1 text-truncate'>
                        <div
                            class='text-truncate'
                            :title='cam.name'
                            v-text='cam.name'
                        />
                        <div
                            class='small text-secondary text-truncate'
                            v-text='cam.provider'
                        />
                    </div>
                    <span
                        v-if='!cam.online'
                        class='small text-secondary'
                    >offline</span>
                    <TablerIconButton
                        :title='isFavorite(cam.id) ? "Remove from favorites" : "Add to favorites"'
                        @click.stop='toggleFavorite(cam)'
                    >
                        <IconStarFilled
                            v-if='isFavorite(cam.id)'
                            :size='20'
                            class='text-yellow'
                        />
                        <IconStar
                            v-else
                            :size='20'
                            stroke='1'
                        />
                    </TablerIconButton>
                    <TablerIconButton
                        v-if='cam.still'
                        title='Show picture'
                        @click.stop='openCamera(pinia, cam, "still")'
                    >
                        <IconPhoto
                            :size='20'
                            stroke='1'
                        />
                    </TablerIconButton>
                    <TablerIconButton
                        v-if='cam.video'
                        title='Play live video'
                        @click.stop='openCamera(pinia, cam, "video")'
                    >
                        <IconPlayerPlay
                            :size='20'
                            stroke='1'
                        />
                    </TablerIconButton>
                </div>
                <div
                    v-if='matched.length > shown.length'
                    class='small text-secondary px-2 py-2'
                >
                    Showing {{ shown.length }} of {{ matched.length }}. Search or zoom in to narrow the list.
                </div>
            </div>

            <template v-if='!state.favoritesOnly && searchWords.length'>
                <div class='small fw-bold text-secondary px-2 pt-3'>
                    Other states
                    <span v-if='other'>({{ other.total.toLocaleString() }})</span>
                </div>
                <div
                    v-if='otherLoading || (other && !other.complete)'
                    class='small text-secondary px-2'
                >
                    Searching every state (the first search takes a little longer)...
                </div>
                <div
                    v-if='otherError'
                    class='small text-danger px-2'
                    v-text='otherError'
                />
                <div
                    v-if='other && other.items.length'
                    class='list-group list-group-flush'
                >
                    <div
                        v-for='cam in other.items'
                        :key='cam.id'
                        class='list-group-item d-flex align-items-center gap-2 px-2 py-2 cursor-pointer hover'
                        role='button'
                        tabindex='0'
                        @click='goTo(cam)'
                        @keyup.enter='goTo(cam)'
                    >
                        <span :class='["cam-dot", !cam.online ? "cam-dot-offline" : (cam.video ? "cam-dot-video" : "cam-dot-still")]' />
                        <div class='flex-grow-1 text-truncate'>
                            <div
                                class='text-truncate'
                                :title='cam.name'
                                v-text='cam.name'
                            />
                            <div
                                class='small text-secondary text-truncate'
                                v-text='`${cam.provider}, ${cam.state}`'
                            />
                        </div>
                        <TablerIconButton
                            :title='isFavorite(cam.id) ? "Remove from favorites" : "Add to favorites"'
                            @click.stop='toggleFavorite(cam)'
                        >
                            <IconStarFilled
                                v-if='isFavorite(cam.id)'
                                :size='20'
                                class='text-yellow'
                            />
                            <IconStar
                                v-else
                                :size='20'
                                stroke='1'
                            />
                        </TablerIconButton>
                    </div>
                    <div
                        v-if='other.total > other.items.length'
                        class='small text-secondary px-2 py-2'
                    >
                        Showing {{ other.items.length }} of {{ other.total.toLocaleString() }}. Add words to narrow the search.
                    </div>
                </div>
                <div
                    v-else-if='other && other.complete'
                    class='small text-secondary px-2'
                >
                    No cameras match in other states.
                </div>
            </template>
        </template>

        <template #footer>
            <div class='small text-secondary px-2 py-1'>
                <div v-if='state.catalog.credit'>
                    {{ state.catalog.credit }}<span v-if='catalogDate'>, catalog of {{ catalogDate }}</span>.
                    Cameras belong to the agency shown on each camera.
                </div>
                <div
                    v-for='p in state.providers'
                    :key='p.id'
                >
                    {{ p.id }}: {{ p.attribution }}<template v-if='p.license'>
                        <span v-if='p.attribution'>, </span>
                        <a
                            v-if='p.license_url'
                            :href='p.license_url'
                            target='_blank'
                            rel='noopener noreferrer'
                            v-text='p.license'
                        />
                        <span
                            v-else
                            v-text='p.license'
                        />
                    </template>
                </div>
                <div>Independent plugin inspired by takwerx Cam Depot for ATAK; not made or supported by takwerx.</div>
            </div>
        </template>
    </MenuTemplate>
</template>

<script setup lang='ts'>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { getActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import {
    TablerAlert,
    TablerIconButton,
    TablerInput,
    TablerLoading,
    TablerNone,
    TablerToggle,
} from '@tak-ps/vue-tabler';
import { IconChevronDown, IconChevronUp, IconPhoto, IconPlayerPlay, IconStar, IconStarFilled } from '@tabler/icons-vue';
import MenuTemplate from '../../src/components/CloudTAK/util/MenuTemplate.vue';
import { useMapStore } from '../../src/stores/map.ts';
import {
    state, loadCameras, savePrefs, sync, passesFilter, countyKey, camerasChanged,
    isFavorite, toggleFavorite, cameraForFavorite, searchOtherStates,
} from './lib/state.ts';
import type { Camera, Favorite, SearchResult } from './lib/state.ts';
import { openCamera } from './lib/open.ts';
import { syncCots, view } from './lib/cots.ts';

const LIST_LIMIT = 200;
const BIG_SELECTION = 5000;

const pinia = getActivePinia() as Pinia;
const mapStore = useMapStore();

const filter = ref('');
const picking = ref(false);

// Search in states that aren't picked (on the server), after a pause in typing
const SEARCH_MIN = 3;
const searchWords = computed(() => {
    const q = filter.value.trim();
    return q.length >= SEARCH_MIN ? q.split(/\s+/) : [];
});
const other = ref<SearchResult | null>(null);
const otherLoading = ref(false);
const otherError = ref('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchRun = 0;

async function runSearch(tries = 0): Promise<void> {
    const q = filter.value.trim();
    if (q.length < SEARCH_MIN) return;
    const run = ++searchRun;
    otherLoading.value = true;
    otherError.value = '';
    try {
        const result = await searchOtherStates(q);
        if (run !== searchRun) return;
        other.value = result;
        // The server is still reading other states: ask again shortly (a few times)
        if (!result.complete && tries < 10) {
            searchTimer = setTimeout(() => { void runSearch(tries + 1); }, 3000);
        }
    } catch (err) {
        if (run === searchRun) otherError.value = err instanceof Error ? err.message : String(err);
    } finally {
        if (run === searchRun) otherLoading.value = false;
    }
}

watch(filter, () => {
    if (searchTimer) clearTimeout(searchTimer);
    other.value = null;
    if (filter.value.trim().length < SEARCH_MIN) {
        searchRun++;
        otherLoading.value = false;
        return;
    }
    searchTimer = setTimeout(() => { void runSearch(); }, 500);
});
const pickingCounties = ref(false);
const countyFilter = ref('');

const providerOptions = computed(() => {
    const n = new Map<string, number>();
    for (const c of state.cameras) n.set(c.provider, (n.get(c.provider) || 0) + 1);
    // Keep a saved choice listed even when no picked state has it
    if (state.provider && !n.has(state.provider)) n.set(state.provider, 0);
    return [...n].map(([id, count]) => ({ id, count })).filter((p) => p.id).sort((a, b) => a.id.localeCompare(b.id));
});

const countyOptions = computed(() => {
    const n = new Map<string, { key: string; label: string; count: number }>();
    for (const c of state.cameras) {
        if (!c.county) continue;
        const key = countyKey(c);
        const have = n.get(key);
        if (have) have.count++;
        else n.set(key, { key, label: state.states.length > 1 ? `${c.county}, ${c.state}` : c.county, count: 1 });
    }
    const words = countyFilter.value.toLowerCase().split(/\s+/).filter(Boolean);
    return [...n.values()]
        .filter((c) => state.counties.includes(c.key) || words.every((w) => c.label.toLowerCase().includes(w)))
        .sort((a, b) => a.label.localeCompare(b.label));
});

const countiesLabel = computed(() => {
    if (!state.counties.length) return 'All counties';
    const names = state.counties.map((k) => k.split('|')[0]);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
});

function toggleCounty(key: string): void {
    state.counties = state.counties.includes(key) ? state.counties.filter((k) => k !== key) : [...state.counties, key];
}

const favoriteRows = computed<Favorite[]>(() => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    return state.favorites
        .filter((f) => words.every((w) => f.name.toLowerCase().includes(w)))
        .sort((a, b) => a.name.localeCompare(b.name));
});

function removeFavorite(id: string): void {
    state.favorites = state.favorites.filter((f) => f.id !== id);
    savePrefs();
}

async function openFavorite(fav: Favorite): Promise<void> {
    mapStore.map.flyTo({ center: [fav.lon, fav.lat], zoom: Math.max(mapStore.map.getZoom(), 12) });
    try {
        const cam = await cameraForFavorite(fav);
        if (cam) openCamera(pinia, cam);
        else state.error = `${fav.name} is no longer in the camera catalog`;
    } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
    }
}
const placeFilter = ref('');

const pickedLabel = computed(() => {
    if (!state.states.length) return 'Pick states';
    const names = state.states.map((id) => state.sources.find((s) => s.id === id)?.name || id);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
});

const pickedCount = computed(() => state.sources
    .filter((s) => state.states.includes(s.id))
    .reduce((n, s) => n + s.cameras, 0));

const placeGroups = computed(() => {
    const words = placeFilter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const match = state.sources.filter((s) => words.every((w) => s.name.toLowerCase().includes(w) || s.id.toLowerCase() === w));
    return [
        { label: 'United States', items: match.filter((s) => s.country !== 'CA') },
        { label: 'Canada', items: match.filter((s) => s.country === 'CA') },
    ];
});

const catalogDate = computed(() => {
    const d = new Date(state.catalog.generated);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
});

let placeTimer: ReturnType<typeof setTimeout> | undefined;

function togglePlace(id: string): void {
    state.states = state.states.includes(id) ? state.states.filter((s) => s !== id) : [...state.states, id];
    savePrefs();
    // Wait for a pause in clicking before loading
    if (placeTimer) clearTimeout(placeTimer);
    placeTimer = setTimeout(() => { void loadCameras(); }, 800);
}
const bounds = ref<[number, number, number, number] | null>(null);

function readView(): void {
    const map = mapStore.map;
    if (!map) return;
    const b = map.getBounds();
    bounds.value = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

const counts = computed(() => {
    const live = state.cameras.filter((c) => c.online);
    const video = live.filter((c) => c.video).length;
    return { video, still: live.length - video, offline: state.cameras.length - live.length };
});

const matched = computed<Camera[]>(() => {
    const words = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const box = state.onScreen ? bounds.value : null;

    return state.cameras.filter((c) => {
        if (!passesFilter(c)) return false;
        if (box && (c.lon < box[0] || c.lon > box[2] || c.lat < box[1] || c.lat > box[3])) return false;
        const name = c.name.toLowerCase();
        return words.every((w) => name.includes(w));
    }).sort((a, b) => a.name.localeCompare(b.name));
});

const shown = computed(() => matched.value.slice(0, LIST_LIMIT));

function goTo(cam: Camera): void {
    mapStore.map.flyTo({ center: [cam.lon, cam.lat], zoom: Math.max(mapStore.map.getZoom(), 12) });
    openCamera(pinia, cam);
}


watch(() => state.visible, async () => {
    savePrefs();
    await syncCots(pinia);
});

watch(() => state.onScreen, savePrefs);
watch(() => state.favoritesOnly, savePrefs);

// Filters change what is on the map too
watch(() => [state.kind, state.provider, state.counties], () => {
    savePrefs();
    camerasChanged();
});


onMounted(async () => {
    readView();
    mapStore.map.on('moveend', readView);
    await loadCameras();
});

onUnmounted(() => {
    if (searchTimer) clearTimeout(searchTimer);
    mapStore.map.off('moveend', readView);
});
</script>

<style scoped>
.cam-label {
    min-width: 64px;
}

.cam-place-list {
    max-height: 260px;
    overflow-y: auto;
}

.cam-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid #ffffff;
    flex: 0 0 auto;
    vertical-align: middle;
}

.cam-dot-video {
    background: #2fb344;
}

.cam-dot-still {
    background: #4299e1;
}

.cam-dot-offline {
    background: #868e96;
}
</style>
