/**
 * Cam Depot for CloudTAK - shared state and camera loading
 */
import { reactive } from 'vue';
import { std, stdurl } from '../../../src/std.ts';

export type Camera = {
    id: string;
    name: string;
    lat: number;
    lon: number;
    /** Picture URL (absolute) */
    still: string | null;
    video: boolean;
    /** Stream URL from the catalog */
    stream: string | null;
    /** false = the agency serves an error or its "camera offline" card */
    online: boolean;
    provider: string;
    county: string;
    fire: boolean;
    state: string;
};

export type StateSource = {
    id: string;
    name: string;
    country: string;
    cameras: number;
};

export type ProviderCredit = {
    id: string;
    attribution: string;
    license: string;
    license_url: string;
};

type StateCameras = {
    cameras: Camera[];
    providers: ProviderCredit[];
    loadedAt: number;
    /** Status version the server sent with this list */
    version: number;
};

/** What is kept of a favorite camera, so favorites work across states */
export type Favorite = {
    id: string;
    name: string;
    state: string;
    provider: string;
    lat: number;
    lon: number;
};

export type Kind = 'all' | 'video' | 'still' | 'fire' | 'offline';

const PREFS_KEY = 'cam-depot:prefs';
const RELOAD_MS = 5 * 60 * 1000;

type Prefs = {
    visible: boolean;
    states: string[];
    onScreen: boolean;
    kind: Kind;
    provider: string;
    /** `County|ST` keys; empty = every county */
    counties: string[];
    favorites: Favorite[];
    favoritesOnly: boolean;
};

const KINDS: Kind[] = ['all', 'video', 'still', 'fire', 'offline'];

function loadPrefs(): Prefs {
    const prefs: Prefs = {
        visible: true, states: [], onScreen: false,
        kind: 'all', provider: '', counties: [], favorites: [], favoritesOnly: false,
    };
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) {
            const saved = JSON.parse(raw) as Partial<Prefs> & { state?: string };
            if (typeof saved.visible === 'boolean') prefs.visible = saved.visible;
            if (typeof saved.onScreen === 'boolean') prefs.onScreen = saved.onScreen;
            if (typeof saved.favoritesOnly === 'boolean') prefs.favoritesOnly = saved.favoritesOnly;
            if (typeof saved.kind === 'string' && KINDS.includes(saved.kind)) prefs.kind = saved.kind;
            if (typeof saved.provider === 'string') prefs.provider = saved.provider;
            if (Array.isArray(saved.counties)) prefs.counties = saved.counties.filter((s) => typeof s === 'string');
            if (Array.isArray(saved.favorites)) {
                prefs.favorites = saved.favorites.filter((f): f is Favorite => !!f && typeof f.id === 'string'
                    && typeof f.name === 'string' && typeof f.state === 'string'
                    && Number.isFinite(f.lat) && Number.isFinite(f.lon));
            }
            if (Array.isArray(saved.states)) prefs.states = saved.states.filter((s) => typeof s === 'string');
            // Milestone 1 kept a single state
            else if (typeof saved.state === 'string') prefs.states = [saved.state];
        }
    } catch { /* storage unavailable - defaults */ }
    return prefs;
}

export const state = reactive({
    ...loadPrefs(),
    sources: [] as StateSource[],
    catalog: { available: false, generated: '', credit: '' },
    cameras: [] as Camera[],
    /** Provider credit lines (attribution / license) for what is loaded */
    providers: [] as ProviderCredit[],
    loading: false,
    syncing: false,
    syncNote: '',
    error: '' as string,
});

const perState = new Map<string, StateCameras>();

export function savePrefs(): void {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            visible: state.visible,
            states: state.states,
            onScreen: state.onScreen,
            kind: state.kind,
            provider: state.provider,
            counties: state.counties,
            favorites: state.favorites,
            favoritesOnly: state.favoritesOnly,
        }));
    } catch { /* storage unavailable */ }
}

const listeners = new Set<() => void>();

/** Called whenever the camera list or the filters change (the map layer redraws) */
export function onCamerasChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function camerasChanged(): void {
    for (const fn of listeners) fn();
}

const statusListeners = new Set<(cameras: Camera[]) => void>();

/** Called with the cameras whose online/offline status changed */
export function onStatusChanged(fn: (cameras: Camera[]) => void): () => void {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
}

export function countyKey(camera: Camera): string {
    return `${camera.county}|${camera.state}`;
}

/** The type / provider / county filters (favorites-only and search are list-only) */
export function passesFilter(camera: Camera): boolean {
    if (state.kind === 'video' && !(camera.online && camera.video)) return false;
    if (state.kind === 'still' && !(camera.online && !camera.video)) return false;
    if (state.kind === 'fire' && !camera.fire) return false;
    if (state.kind === 'offline' && camera.online) return false;
    if (state.provider && camera.provider !== state.provider) return false;
    if (state.counties.length && !state.counties.includes(countyKey(camera))) return false;
    return true;
}

export function isFavorite(id: string): boolean {
    return state.favorites.some((f) => f.id === id);
}

export function toggleFavorite(camera: Camera): void {
    if (isFavorite(camera.id)) {
        state.favorites = state.favorites.filter((f) => f.id !== camera.id);
    } else {
        state.favorites = [...state.favorites, {
            id: camera.id, name: camera.name, state: camera.state,
            provider: camera.provider, lat: camera.lat, lon: camera.lon,
        }];
    }
    savePrefs();
}

/**
 * The current camera behind a favorite. Its state may not be picked, so the
 * list is fetched then (and kept briefly): stream links can change, so a saved
 * copy is never used to open a camera.
 */
const favoriteStates = new Map<string, StateCameras>();

export async function cameraForFavorite(fav: Favorite): Promise<Camera | undefined> {
    const shown = state.cameras.find((c) => c.id === fav.id);
    if (shown) return shown;
    let loaded = favoriteStates.get(fav.state);
    if (!loaded || Date.now() - loaded.loadedAt > RELOAD_MS) {
        loaded = await fetchState(fav.state);
        favoriteStates.set(fav.state, loaded);
    }
    return loaded.cameras.find((c) => c.id === fav.id);
}

export async function loadStates(): Promise<void> {
    const body = await std('/api/cam-depot/states') as {
        catalog: { available: boolean; generated: string; credit: string };
        items: StateSource[];
    };
    state.sources = body.items;
    state.catalog = body.catalog;

    const known = new Set(state.sources.map((s) => s.id));
    const kept = state.states.filter((s) => known.has(s));
    if (kept.length !== state.states.length) {
        state.states = kept;
        savePrefs();
    }
}

async function fetchState(st: string): Promise<StateCameras> {
    const url = stdurl('/api/cam-depot/cameras');
    url.searchParams.set('state', st);
    const body = await std(url) as {
        version: number;
        providers: ProviderCredit[];
        items: Camera[];
    };
    return {
        providers: body.providers,
        loadedAt: Date.now(),
        version: body.version,
        cameras: body.items.map((c) => ({
            ...c,
            // The server may hand back a path on itself (live pictures)
            still: c.still ? new URL(c.still, stdurl('/')).href : null,
            state: st,
        })),
    };
}

function merge(): void {
    const cameras: Camera[] = [];
    const providers = new Map<string, ProviderCredit>();

    for (const st of state.states) {
        const loaded = perState.get(st);
        if (!loaded) continue;
        cameras.push(...loaded.cameras);
        for (const p of loaded.providers) providers.set(p.id, p);
    }

    state.cameras = cameras;
    state.providers = [...providers.values()];
}

/** Load every selected state (each kept for 5 minutes unless forced) */
let again = false;

export async function loadCameras(force = false): Promise<void> {
    // A change made while loading is picked up right after
    if (state.loading) {
        again = true;
        return;
    }

    state.loading = true;
    state.error = '';
    const errors: string[] = [];
    try {
        if (!state.sources.length || force) await loadStates();

        await Promise.all(state.states.map(async (st) => {
            const have = perState.get(st);
            if (have && !force && Date.now() - have.loadedAt < RELOAD_MS) return;
            try {
                perState.set(st, await fetchState(st));
            } catch (err) {
                errors.push(`${st}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }));

        for (const st of [...perState.keys()]) {
            if (!state.states.includes(st)) perState.delete(st);
        }
        merge();
        if (errors.length) state.error = errors.join('; ');
    } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
    } finally {
        state.loading = false;
        for (const fn of listeners) fn();
    }

    if (again) {
        again = false;
        await loadCameras();
    }
}

/** Sync: ask the server to check the catalog for changes, then reload the cameras */
export async function sync(): Promise<void> {
    if (state.syncing) return;
    state.syncing = true;
    state.syncNote = '';
    try {
        const before = state.catalog.generated;
        const body = await std('/api/cam-depot/sync', { method: 'POST' }) as { checked: boolean; generated: string; available: boolean };
        perState.clear();
        await loadCameras(true);
        if (!body.checked) state.syncNote = 'Checked recently - camera lists reloaded';
        else if (body.generated && body.generated !== before) state.syncNote = 'New camera catalog loaded';
        else state.syncNote = 'Camera catalog is up to date';
    } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
    } finally {
        state.syncing = false;
    }
}

/**
 * Status poll (every 15 s from the plugin, only while cameras are on the map):
 * ask the server which cameras are offline, per picked state, and pass on only
 * the cameras that changed.
 */
export async function refreshStatus(): Promise<void> {
    if (state.loading) return;
    const changed: Camera[] = [];

    for (const st of state.states) {
        const loaded = perState.get(st);
        if (!loaded) continue;
        try {
            const url = stdurl('/api/cam-depot/status');
            url.searchParams.set('state', st);
            url.searchParams.set('version', String(loaded.version));
            const body = await std(url) as { version: number; changed: boolean; offline: string[] };
            loaded.version = body.version;
            if (!body.changed) continue;

            const offline = new Set(body.offline);
            for (const camera of loaded.cameras) {
                const online = !offline.has(camera.id);
                if (camera.online !== online) {
                    camera.online = online;
                    changed.push(camera);
                }
            }
        } catch { /* try again on the next poll */ }
    }

    if (changed.length) {
        // The list holds the same objects; reassign so the panel recounts
        state.cameras = [...state.cameras];
        for (const fn of statusListeners) fn(changed);
    }
}

export type SearchResult = { complete: boolean; total: number; items: Camera[] };

/** Search every state the user hasn't picked (picked states are searched in the browser) */
export async function searchOtherStates(q: string): Promise<SearchResult> {
    const url = stdurl('/api/cam-depot/search');
    url.searchParams.set('q', q);
    if (state.states.length) url.searchParams.set('exclude', state.states.join(','));
    const body = await std(url) as SearchResult;
    return {
        ...body,
        items: body.items.map((c) => ({ ...c, still: c.still ? new URL(c.still, stdurl('/')).href : null })),
    };
}

export function findCamera(id: string): Camera | undefined {
    return state.cameras.find((c) => c.id === id);
}
