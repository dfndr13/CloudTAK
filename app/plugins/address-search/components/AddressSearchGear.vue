<template>
    <div class='address-search-gear'>
        <h4>Datasets</h4>

        <div
            v-if='datasets.length === 0'
            class='address-search-gear__empty'
        >
            <template v-if='managedStatus'>
                Downloading {{ managedStatus.label }}… {{ managedStatus.sectionsDone }}/{{ managedStatus.sectionsTotal }}
            </template>
            <template v-else-if='isAdmin'>
                No datasets loaded yet — add one below.
            </template>
            <template v-else>
                Address data downloads automatically the next time this device is online.
            </template>
        </div>
        <div
            v-for='dataset in datasets'
            :key='dataset.datasetId'
            class='address-search-gear__dataset'
        >
            <div class='address-search-gear__dataset-row'>
                <input
                    type='checkbox'
                    :checked='dataset.enabled'
                    @change='onToggleDataset(dataset.datasetId, $event)'
                >
                <strong>{{ dataset.label }}</strong>
                <span class='address-search-gear__muted'>{{ datasetCountLabel(dataset) }}</span>
                <div
                    v-if='isAdmin'
                    role='button'
                    tabindex='0'
                    class='address-search-gear__remove'
                    title='Remove dataset'
                    @click='onRemove(dataset.datasetId)'
                >
                    <IconTrash
                        :size='16'
                        stroke='2'
                    />
                </div>
            </div>
            <div class='address-search-gear__muted'>
                Storage: {{ dataset.persisted ? 'persisted' : 'best-effort (may be evicted under disk pressure)' }}
                <span v-if='dataset.managedPackId'> · from the server, updated {{ formatDate(dataset.createdAt) }}</span>
                <span v-else-if='dataset.sourceUrl'> · loaded from URL</span>
            </div>
        </div>

        <template v-if='isAdmin'>
            <hr>

            <h4>Add a dataset</h4>
            <p class='address-search-gear__muted'>
                Both options below load data into <strong>this browser only</strong> — neither one uploads or shares
                anything. Works for either kind of <code>.pack</code> file this project's CLI can build — street
                addresses (from OpenAddresses) or named places like mountains and trails (from USGS GNIS) — the
                file/URL is auto-detected, there's no separate "type" to pick. For other people to get the same data,
                add it to the server's pack list (<code>packs.json</code>, see <code>docs/HOSTING.md</code>) — every
                browser then downloads it automatically. Only CloudTAK system admins see this section.
            </p>
            <label class='address-search-gear__field-label'>From a file (this device only)</label>
            <div class='address-search-gear__add-row'>
                <input
                    type='file'
                    accept='.pack'
                    @change='onFilePicked'
                >
            </div>
            <label class='address-search-gear__field-label'>From a URL (this browser only)</label>
            <div class='address-search-gear__add-row'>
                <input
                    v-model='urlInput'
                    type='text'
                    placeholder='https://.../state.pack'
                    class='address-search-gear__url-input'
                >
                <button
                    type='button'
                    :disabled='!urlInput.trim() || loading'
                    @click='onLoadFromUrl'
                >
                    Load
                </button>
            </div>
            <div
                v-if='loading'
                class='address-search-gear__progress'
            >
                Loading… {{ progress.sectionsDone }}/{{ progress.sectionsTotal }} sections
                ({{ formatBytes(progress.bytesDone) }} / {{ formatBytes(progress.bytesTotal) }})
            </div>
            <div
                v-if='errorMessage'
                class='address-search-gear__error'
            >
                {{ errorMessage }}
            </div>

            <hr>

            <h4>Online fallback</h4>
            <p class='address-search-gear__muted'>
                Per-device only — never shared with other users or stored in the dataset manifest
                (decision #17). Treat as public: restrict it by referrer / rate-cap it at the vendor.
            </p>
            <div class='address-search-gear__add-row'>
                <select v-model='apiKeyProvider'>
                    <option value='geoapify'>
                        Geoapify
                    </option>
                    <option value='locationiq'>
                        LocationIQ
                    </option>
                    <option value='radar'>
                        Radar
                    </option>
                    <option value='here'>
                        HERE
                    </option>
                </select>
                <input
                    v-model='apiKeyValue'
                    type='text'
                    placeholder='API key'
                    class='address-search-gear__url-input'
                    @change='saveApiKey'
                >
            </div>
        </template>
    </div>
</template>

<script setup lang='ts'>
import { onMounted, ref, watch } from 'vue';
import { IconTrash } from '@tabler/icons-vue';
import { datasetsVersion, isAdmin, managedStatus, workerClient } from '../lib/state.ts';
import { listDatasets, removeDataset, setEnabled } from '../lib/storage/dataset-store.ts';
import { loadFromFile, loadFromUrl, type UploadProgress } from '../lib/storage/upload.ts';
import { syncManifestKv } from '../lib/manifest-sync.ts';
import type { DatasetRecord } from '../lib/storage/schema.ts';

const API_KEY_STORAGE_PREFIX = 'cloudtak-address-search:api-key:';

const datasets = ref<DatasetRecord[]>([]);
const urlInput = ref('');
const loading = ref(false);
const errorMessage = ref('');
const progress = ref<UploadProgress>({ sectionsDone: 0, sectionsTotal: 0, bytesDone: 0, bytesTotal: 0 });
const apiKeyProvider = ref<'geoapify' | 'locationiq' | 'radar' | 'here'>('geoapify');
const apiKeyValue = ref('');

/** Phase 8: a gazetteer dataset has no house numbers, so "addresses" would be a misleading label
 *  for its record count — branch on kind rather than reusing the address wording for both. */
function datasetCountLabel(dataset: DatasetRecord): string {
    return dataset.kind === "gazetteer"
        ? `${dataset.recordCount.toLocaleString()} places`
        : `${dataset.addressCount.toLocaleString()} addresses`;
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function refresh(): Promise<void> {
    datasets.value = await listDatasets();
}

async function onToggleDataset(datasetId: string, event: Event): Promise<void> {
    await setEnabled(datasetId, (event.target as HTMLInputElement).checked);
    await workerClient.value?.refresh();
    await refresh();
    void syncManifestKv();
}

async function onRemove(datasetId: string): Promise<void> {
    await removeDataset(datasetId);
    await workerClient.value?.refresh();
    await refresh();
    void syncManifestKv();
}

async function onFilePicked(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    loading.value = true;
    errorMessage.value = '';
    try {
        await loadFromFile(file, { onProgress: (p) => (progress.value = p) });
        await workerClient.value?.refresh();
        await refresh();
        void syncManifestKv();
    } catch (err) {
        errorMessage.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
}

async function onLoadFromUrl(): Promise<void> {
    const url = urlInput.value.trim();
    if (!url) return;
    loading.value = true;
    errorMessage.value = '';
    try {
        await loadFromUrl(url, { onProgress: (p) => (progress.value = p) });
        await workerClient.value?.refresh();
        await refresh();
        void syncManifestKv();
        urlInput.value = '';
    } catch (err) {
        errorMessage.value = err instanceof Error ? err.message : String(err);
    } finally {
        loading.value = false;
    }
}

function saveApiKey(): void {
    try {
        localStorage.setItem(`${API_KEY_STORAGE_PREFIX}${apiKeyProvider.value}`, apiKeyValue.value);
    } catch (err) {
        console.warn('[address-search] failed to save API key', err);
    }
}

function loadApiKey(): void {
    try {
        apiKeyValue.value = localStorage.getItem(`${API_KEY_STORAGE_PREFIX}${apiKeyProvider.value}`) ?? '';
    } catch {
        apiKeyValue.value = '';
    }
}

watch(apiKeyProvider, loadApiKey);
watch(datasetsVersion, () => void refresh());

onMounted(() => {
    void refresh();
    loadApiKey();
});
</script>

<style scoped>
.address-search-gear {
    padding: 12px;
    overflow-y: auto;
    height: 100%;
}
.address-search-gear__dataset {
    padding: 6px 0;
    border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}
.address-search-gear__dataset-row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.address-search-gear__remove {
    margin-left: auto;
    cursor: pointer;
    opacity: 0.7;
}
.address-search-gear__remove:hover {
    opacity: 1;
}
.address-search-gear__muted {
    opacity: 0.65;
    font-size: 0.85em;
}
.address-search-gear__add-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0;
}
.address-search-gear__field-label {
    display: block;
    font-size: 0.8em;
    opacity: 0.7;
    margin-top: 8px;
}
.address-search-gear__url-input {
    flex: 1;
    min-width: 0;
}
.address-search-gear__progress {
    font-size: 0.85em;
    opacity: 0.8;
}
.address-search-gear__error {
    color: #d9534f;
    font-size: 0.85em;
}
.address-search-gear__empty {
    opacity: 0.65;
    font-style: italic;
}
</style>
