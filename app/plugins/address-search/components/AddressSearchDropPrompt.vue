<template>
    <div class='address-search-drop'>
        <input
            v-model='callsign'
            type='text'
            class='address-search-drop__input'
            placeholder='Callsign'
        >
        <select
            v-model='pointType'
            class='address-search-drop__input'
        >
            <option
                v-for='opt in POINT_TYPE_OPTIONS'
                :key='opt.value'
                :value='opt.value'
            >
                {{ opt.label }}
            </option>
        </select>

        <div class='address-search-drop__actions'>
            <button
                type='button'
                :disabled='saving'
                @click='keepLocal'
            >
                Keep Local
            </button>
            <button
                type='button'
                :disabled='saving'
                @click='saveAndShare'
            >
                <IconMapPinShare
                    :size='16'
                    stroke='2'
                />
                Save &amp; Share…
            </button>
            <div
                role='button'
                tabindex='0'
                class='address-search-drop__cancel'
                title='Cancel'
                @click='emit("close")'
            >
                <IconX
                    :size='16'
                    stroke='2'
                />
            </div>
        </div>

        <div
            v-if='errorMessage'
            class='address-search-drop__error'
        >
            {{ errorMessage }}
        </div>
    </div>
</template>

<script setup lang='ts'>
import { onMounted, ref } from 'vue';
import { IconMapPinShare, IconX } from '@tabler/icons-vue';
import { api, pinia } from '../lib/state.ts';
import { defaultPointType, dropMarker } from '../lib/core-bridge.ts';
import AddressSearchShareWrapper from './AddressSearchShareWrapper.vue';
import type { SearchResult } from '../lib/search/types.ts';

const SHARE_FLOAT_UID = 'address-search-share';

// Mirrors core's own point-type picker (api/web/src/components/CloudTAK/util/CoordinateType.vue /
// api/web/src/utils/point-type.ts LegacyPointTypes) so this prompt looks and behaves like the
// rest of the app instead of inventing a new scheme.
const POINT_TYPE_OPTIONS = [
    { value: 'u-d-p', label: 'Custom' },
    { value: 'a-u-G', label: 'Unknown' },
    { value: 'a-f-G', label: 'Friendly' },
    { value: 'a-h-G', label: 'Hostile' },
    { value: 'a-n-G', label: 'Neutral' },
];
const KNOWN_POINT_TYPES = new Set(POINT_TYPE_OPTIONS.map((o) => o.value));

const props = defineProps<{ result: SearchResult }>();
const emit = defineEmits<{ close: [] }>();

const callsign = ref(props.result.displayAddress);
const pointType = ref('u-d-p');
const saving = ref(false);
const errorMessage = ref('');

onMounted(() => {
    if (!pinia.value) return;
    const preferred = defaultPointType(pinia.value);
    if (KNOWN_POINT_TYPES.has(preferred)) pointType.value = preferred;
});

function flyToResult(): void {
    api.value?.map.flyTo({ center: [props.result.lon, props.result.lat], zoom: 17 });
}

async function drop(authored: boolean): Promise<Record<string, unknown> | undefined> {
    if (!pinia.value || !callsign.value.trim()) return undefined;
    saving.value = true;
    errorMessage.value = '';
    try {
        const feature = await dropMarker(pinia.value, {
            point: { lat: props.result.lat, lon: props.result.lon },
            callsign: callsign.value.trim(),
            pointType: pointType.value,
            authored,
        });
        if (!feature) {
            errorMessage.value = 'Could not drop marker — see console for details.';
            return undefined;
        }
        return feature;
    } finally {
        saving.value = false;
    }
}

async function keepLocal(): Promise<void> {
    const feature = await drop(false);
    if (!feature) return;
    flyToResult();
    emit('close');
}

async function saveAndShare(): Promise<void> {
    const feature = await drop(true);
    if (!feature) return;
    flyToResult();
    api.value?.float.add({
        uid: SHARE_FLOAT_UID,
        name: 'Share Feature',
        component: AddressSearchShareWrapper,
        props: { feats: [feature] },
        width: 480,
        height: 520,
    });
    emit('close');
}
</script>

<style scoped>
.address-search-drop {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--tblr-border-color, rgba(128, 128, 128, 0.3));
}
.address-search-drop__input {
    width: 100%;
}
.address-search-drop__actions {
    display: flex;
    align-items: center;
    gap: 6px;
}
.address-search-drop__actions button {
    display: flex;
    align-items: center;
    gap: 4px;
}
.address-search-drop__cancel {
    margin-left: auto;
    cursor: pointer;
    opacity: 0.7;
    display: flex;
}
.address-search-drop__cancel:hover {
    opacity: 1;
}
.address-search-drop__error {
    color: #d9534f;
    font-size: 0.85em;
}
</style>
