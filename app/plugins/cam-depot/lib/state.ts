/**
 * CloudTAK CAM Depot - shared state and camera loading
 */
import { reactive } from 'vue';
import { std, stdurl } from '../../../src/std.ts';

export type Camera = {
    id: string;
    name: string;
    lat: number;
    lon: number;
    still: string | null;
    video: boolean;
    /** false = the agency serves an error or its "camera offline" card */
    online: boolean;
};

export type StateSource = {
    id: string;
    name: string;
    attribution: string;
};

const PREFS_KEY = 'cam-depot:prefs';
const RELOAD_MS = 5 * 60 * 1000;

type Prefs = {
    visible: boolean;
    state: string;
    onScreen: boolean;
};

function loadPrefs(): Prefs {
    const prefs: Prefs = { visible: true, state: 'KS', onScreen: false };
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        if (raw) Object.assign(prefs, JSON.parse(raw));
    } catch { /* storage unavailable - defaults */ }
    return prefs;
}

export const state = reactive({
    ...loadPrefs(),
    states: [] as StateSource[],
    cameras: [] as Camera[],
    attribution: '',
    updated: '',
    loading: false,
    error: '' as string,
    loadedAt: 0,
});

export function savePrefs(): void {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({
            visible: state.visible,
            state: state.state,
            onScreen: state.onScreen,
        }));
    } catch { /* storage unavailable */ }
}

const listeners = new Set<() => void>();

/** Called whenever the camera list changes (the map layer redraws) */
export function onCamerasChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export async function loadStates(): Promise<void> {
    const body = await std('/api/cam-depot/states') as { items: StateSource[] };
    state.states = body.items;
    if (!state.states.some((s) => s.id === state.state) && state.states.length) {
        state.state = state.states[0].id;
    }
}

export async function loadCameras(force = false): Promise<void> {
    if (!force && state.cameras.length && Date.now() - state.loadedAt < RELOAD_MS) return;
    if (state.loading) return;

    state.loading = true;
    state.error = '';
    try {
        if (!state.states.length) await loadStates();
        const url = stdurl('/api/cam-depot/cameras');
        url.searchParams.set('state', state.state);
        const body = await std(url) as { items: Camera[]; attribution: string; updated: string };
        state.cameras = body.items;
        state.attribution = body.attribution;
        state.updated = body.updated;
        state.loadedAt = Date.now();
    } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
    } finally {
        state.loading = false;
        for (const fn of listeners) fn();
    }
}

export function findCamera(id: string): Camera | undefined {
    return state.cameras.find((c) => c.id === id);
}
