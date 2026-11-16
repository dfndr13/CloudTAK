<template>
    <MenuTemplate
        name='CAM Depot'
        :loading='false'
    >
        <template #buttons>
            <TablerRefreshButton
                :loading='state.loading'
                @click='refresh'
            />
        </template>

        <template #default>
            <div class='col-12 px-2 py-2 d-flex flex-column gap-2'>
                <TablerToggle
                    v-model='state.visible'
                    label='Show cameras on the map'
                />

                <div
                    v-if='state.states.length > 1'
                    class='d-flex align-items-center gap-2'
                >
                    <label class='form-label mb-0'>State</label>
                    <select
                        v-model='state.state'
                        class='form-select form-select-sm'
                    >
                        <option
                            v-for='s in state.states'
                            :key='s.id'
                            :value='s.id'
                            v-text='s.name'
                        />
                    </select>
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
            <TablerLoading
                v-else-if='state.loading && !state.cameras.length'
                desc='Loading cameras'
            />
            <TablerNone
                v-else-if='!shown.length'
                label='No cameras match'
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
                    <span
                        class='flex-grow-1 text-truncate'
                        :title='cam.name'
                        v-text='cam.name'
                    />
                    <span
                        v-if='!cam.online'
                        class='small text-secondary'
                    >offline</span>
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
        </template>

        <template #footer>
            <div class='small text-secondary px-2 py-1'>
                <div v-if='state.attribution'>
                    Cameras: {{ state.attribution }}
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
    TablerRefreshButton,
    TablerToggle,
} from '@tak-ps/vue-tabler';
import { IconPhoto, IconPlayerPlay } from '@tabler/icons-vue';
import MenuTemplate from '../../src/components/CloudTAK/util/MenuTemplate.vue';
import { useMapStore } from '../../src/stores/map.ts';
import { state, loadCameras, savePrefs } from './lib/state.ts';
import type { Camera } from './lib/state.ts';
import { openCamera } from './lib/open.ts';
import { syncCots } from './lib/cots.ts';

const LIST_LIMIT = 200;

const pinia = getActivePinia() as Pinia;
const mapStore = useMapStore();

const filter = ref('');
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

async function refresh(): Promise<void> {
    await loadCameras(true);
}

watch(() => state.visible, async () => {
    savePrefs();
    await syncCots(pinia);
});

watch(() => state.onScreen, savePrefs);

watch(() => state.state, async () => {
    savePrefs();
    await loadCameras(true);
});

onMounted(async () => {
    readView();
    mapStore.map.on('moveend', readView);
    await loadCameras();
});

onUnmounted(() => {
    mapStore.map.off('moveend', readView);
});
</script>

<style scoped>
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
