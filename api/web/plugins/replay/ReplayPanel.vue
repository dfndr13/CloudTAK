<!-- api/web/plugins/replay/ReplayPanel.vue -->
<template>
    <div class='replay-panel p-2'>
        <!-- Recording ---------------------------------------------------- -->
        <div class='mb-3 border-bottom pb-2'>
            <div v-if='!recording.active'>
                <label class='form-label small'>Event name</label>
                <div class='d-flex gap-2'>
                    <input
                        v-model='newEventName'
                        class='form-control form-control-sm'
                        placeholder='e.g. KSF 2026'
                    >
                    <button
                        class='btn btn-sm btn-danger'
                        :disabled='!newEventName'
                        @click='startRecording'
                    >
                        Record
                    </button>
                </div>
            </div>
            <div
                v-else
                class='d-flex align-items-center justify-content-between'
            >
                <span class='text-danger'>&#9679; Recording: {{ recording.event?.name }}</span>
                <button
                    class='btn btn-sm btn-outline-danger'
                    @click='stopRecording'
                >
                    Stop
                </button>
            </div>
        </div>

        <!-- Event picker --------------------------------------------------- -->
        <div
            v-if='!session'
            class='mb-3'
        >
            <label class='form-label small'>Recorded events</label>
            <select
                v-model='selectedEventId'
                class='form-select form-select-sm'
            >
                <option
                    v-for='e in events'
                    :key='e.id'
                    :value='e.id'
                >
                    {{ e.name }} ({{ new Date(e.started_at).toLocaleString() }})
                </option>
            </select>
            <button
                class='btn btn-sm btn-primary mt-2 w-100'
                :disabled='!selectedEventId'
                @click='startPlayback'
            >
                Start Playback
            </button>

            <div class='d-flex gap-2 mt-2'>
                <button
                    class='btn btn-sm btn-outline-secondary flex-fill'
                    :disabled='!selectedEventId'
                    @click='exportEvent'
                >
                    Export
                </button>
                <label class='btn btn-sm btn-outline-secondary flex-fill mb-0'>
                    Import
                    <input
                        type='file'
                        accept='.json'
                        class='d-none'
                        @change='importEvent'
                    >
                </label>
            </div>
        </div>

        <!-- Playback controls ----------------------------------------------- -->
        <div v-else>
            <div class='alert alert-danger py-1 px-2 mb-2 text-center small fw-bold'>
                {{ activeEventName }} Playback
            </div>
            <div class='d-flex align-items-center gap-2 mb-2'>
                <button
                    class='btn btn-sm btn-outline-secondary'
                    @click='back'
                >
                    &lt;
                </button>
                <button
                    v-if='!paused'
                    class='btn btn-sm btn-outline-secondary'
                    @click='pause'
                >
                    Pause
                </button>
                <button
                    v-else
                    class='btn btn-sm btn-outline-secondary'
                    @click='resume'
                >
                    Play
                </button>
                <button
                    class='btn btn-sm btn-outline-danger ms-auto'
                    @click='stopPlayback'
                >
                    Stop
                </button>
            </div>

            <input
                v-model.number='progressPercent'
                type='range'
                min='0'
                max='100'
                class='form-range mb-1'
                @change='seekPercent'
            >
            <div class='small text-muted mb-2'>
                {{ progressLabel }}
            </div>

            <div class='d-flex align-items-center gap-2 mb-3'>
                <label class='small mb-0'>Speed</label>
                <select
                    v-model.number='speed'
                    class='form-select form-select-sm w-auto'
                    @change='setSpeed'
                >
                    <option
                        v-for='s in [1,2,5,10,15,30,50]'
                        :key='s'
                        :value='s'
                    >
                        {{ s }}x
                    </option>
                </select>
            </div>

            <div class='mb-2'>
                <label class='form-label small d-block'>Show</label>
                <div
                    v-for='cat in categories'
                    :key='cat'
                    class='form-check form-check-inline'
                >
                    <input
                        :id='`cat-${cat}`'
                        v-model='activeCategories[cat]'
                        class='form-check-input'
                        type='checkbox'
                        @change='toggleCategory(cat)'
                    >
                    <label
                        class='form-check-label small text-capitalize'
                        :for='`cat-${cat}`'
                    >{{ cat }}</label>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { std } from '../../src/std.ts';
import FeatureManager from '../../src/base/feature.ts';
import { FeatureVisibility } from '../../src/stores/modules/feature-visibility.ts';

type Category = 'aircraft' | 'uas' | 'ground' | 'maritime' | 'other';
const categories: Category[] = ['aircraft', 'uas', 'ground', 'maritime', 'other'];

interface ReplayEvent {
    id: number;
    name: string;
    started_at: string;
    ended_at?: string;
    status: string;
}

const events = ref<ReplayEvent[]>([]);
const selectedEventId = ref<number | null>(null);
const activeEventName = ref('');
let hiddenLiveIds: string[] = [];
const newEventName = ref('');
const recording = reactive<{ active: boolean; event?: { id: number; name: string } }>({ active: false });

const session = ref<string | null>(null);
const paused = ref(false);
const speed = ref(1);
const progressPercent = ref(0);
const progressLabel = ref('');
const activeCategories = reactive<Record<Category, boolean>>({
    aircraft: true, uas: true, ground: true, maritime: true, other: true,
});

let pollHandle: ReturnType<typeof setInterval> | undefined;

async function pollStatus() {
    if (!session.value) return;
    const body = await std(`/api/replay/session/${session.value}/status`) as { active: boolean; paused?: boolean; percent?: number };
    if (!body.active) {
        session.value = null;
        if (pollHandle) clearInterval(pollHandle);
        restoreLiveFeatures();
        progressLabel.value = 'Playback finished';
        return;
    }
    paused.value = !!body.paused;
    progressPercent.value = Math.round(body.percent || 0);
    progressLabel.value = `Progress: ${progressPercent.value}%`;
}

onMounted(async () => {
    await refreshEvents();
    await refreshRecordingStatus();
});

onUnmounted(() => {
    if (pollHandle) clearInterval(pollHandle);
    if (session.value) restoreLiveFeatures();
});

async function refreshEvents() {
    const body = await std('/api/replay/event') as { events: ReplayEvent[] };
    events.value = body.events;
}

async function refreshRecordingStatus() {
    const body = await std('/api/replay/record/status') as { active: boolean; event?: { id: number; name: string } };
    recording.active = body.active;
    recording.event = body.event;
}

async function startRecording() {
    await std('/api/replay/record/start', { method: 'POST', body: { name: newEventName.value } });
    newEventName.value = '';
    await refreshRecordingStatus();
}

async function stopRecording() {
    await std('/api/replay/record/stop', { method: 'POST' });
    await refreshRecordingStatus();
    await refreshEvents();
}

async function hideLiveFeatures() {
    const live = await FeatureManager.list();
    hiddenLiveIds = live.map((f) => f.id);
    if (hiddenLiveIds.length) FeatureVisibility.setFeaturesHidden(hiddenLiveIds, true);
}

async function hideNewLiveFeatures() {
    const live = await FeatureManager.list();
    const replayIds = live
        .filter((f) => f.properties.replay === true)
        .map((f) => f.id);

    // Replay-origin features must never be hidden - even if their UID was
    // already hidden as "live" (e.g. hidden at playback start, then updated
    // by the replay itself), unhide it as soon as we see the replay tag.
    const toUnhide = replayIds.filter((id) => hiddenLiveIds.includes(id));
    if (toUnhide.length) {
        FeatureVisibility.setFeaturesHidden(toUnhide, false);
        hiddenLiveIds = hiddenLiveIds.filter((id) => !toUnhide.includes(id));
    }

    const replaySet = new Set(replayIds);
    const newIds = live
        .map((f) => f.id)
        .filter((id) => !hiddenLiveIds.includes(id) && !replaySet.has(id));
    if (newIds.length) {
        FeatureVisibility.setFeaturesHidden(newIds, true);
        hiddenLiveIds.push(...newIds);
    }
}

function restoreLiveFeatures() {
    if (hiddenLiveIds.length) FeatureVisibility.setFeaturesHidden(hiddenLiveIds, false);
    hiddenLiveIds = [];
}

async function startPlayback() {
    if (!selectedEventId.value) return;
    const evt = events.value.find((e) => e.id === selectedEventId.value);
    activeEventName.value = evt ? evt.name : 'Replay';

    await hideLiveFeatures();

    const body = await std(`/api/replay/event/${selectedEventId.value}/play`, {
        method: 'POST',
        body: { speed: speed.value },
    }) as { sessionId: string };
    session.value = body.sessionId;
    paused.value = false;
    progressPercent.value = 0;
    progressLabel.value = 'Starting...';
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(async () => {
        await pollStatus();
        await hideNewLiveFeatures();
    }, 1000);
}

async function pause() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/pause`, { method: 'POST' });
    paused.value = true;
}

async function resume() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/resume`, { method: 'POST' });
    paused.value = false;
}

async function back() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/back`, { method: 'POST', body: { wallSeconds: 30 } });
    paused.value = true;
}

async function seekPercent() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/seek`, {
        method: 'POST',
        body: { percent: progressPercent.value },
    });
    paused.value = true;
}

async function setSpeed() {
}

async function toggleCategory(cat: Category) {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/category`, {
        method: 'POST',
        body: { category: cat, on: activeCategories[cat] },
    });
}

async function stopPlayback() {
    if (!session.value) return;
    await std(`/api/replay/session/${session.value}/stop`, { method: 'POST' });
    session.value = null;
    if (pollHandle) clearInterval(pollHandle);
    restoreLiveFeatures();
}

async function exportEvent() {
    if (!selectedEventId.value) return;
    const body = await std(`/api/replay/event/${selectedEventId.value}/export`) as unknown;
    const blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `replay-export-${selectedEventId.value}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

async function importEvent(evt: Event) {
    const input = evt.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const text = await file.text();
    const parsed = JSON.parse(text);

    await std('/api/replay/import', { method: 'POST', body: parsed });
    await refreshEvents();
    input.value = '';
}
</script>
