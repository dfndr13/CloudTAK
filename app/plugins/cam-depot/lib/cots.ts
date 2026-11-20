/**
 * Cam Depot for CloudTAK - cameras as local CoT markers
 *
 * Each camera is added to CloudTAK's own feature store as a CoT, so it gets the
 * normal click/radial menu, and the radial play button opens its picture or
 * video (`video.url`). They are added the way CloudTAK adds CoT received from
 * the server: never archived, so CloudTAK never sends them to TAK Server. A
 * stale time keeps them from outliving the plugin; they are refreshed on every
 * camera reload.
 */
import { reactive } from 'vue';
import type { Pinia } from 'pinia';
import { useMapStore } from '../../../src/stores/map.ts';
import { db as localDb } from '../../../src/database.ts';
import type { InputFeature } from '../../../src/types.ts';
import { state, passesFilter } from './state.ts';
import type { Camera } from './state.ts';
import { videoUrl } from './open.ts';

export const UID_PREFIX = 'cam-depot-';
/** Above this many cameras, only those nearest the map view become markers */
export const MARKER_CAP = 2000;
/** The view is widened by this share on each side, so a small pan needs no redraw */
const VIEW_PAD = 0.25;

/** What the map is showing, for the panel */
export const view = reactive({ limited: false, total: 0, drawn: 0 });

/** Marker ids currently on the map */
let drawn = new Set<string>();
const STALE_MS = 15 * 60 * 1000;

// No custom icon: CloudTAK draws its built-in icon for the camera CoT type
// (b-m-p-s-p-loc, same as the Node-RED KDOT feed), recoloured by marker-color
export const VIDEO_COLOR = '#2fb344';
export const STILL_COLOR = '#4299e1';
export const OFFLINE_COLOR = '#868e96';

function remarks(camera: Camera, status: string): string {
    const lines = [status, `Provider: ${camera.provider || 'agency'}`];
    const credit = state.providers.find((p) => p.id === camera.provider);
    if (credit && credit.attribution) lines.push(credit.attribution);
    if (credit && credit.license) lines.push(`License: ${credit.license}${credit.license_url ? ` (${credit.license_url})` : ''}`);
    lines.push(state.catalog.credit);
    lines.push('Cam Depot for CloudTAK');
    return lines.join('\n');
}

function feature(camera: Camera, now: Date): InputFeature | null {
    const url = camera.video ? videoUrl(camera) : camera.still;
    if (!url) return null;

    const uid = UID_PREFIX + camera.id;
    const status = !camera.online ? 'Offline (camera status from the catalog)' : (camera.video ? 'Live video' : 'Picture only');

    return {
        id: uid,
        type: 'Feature',
        path: '/',
        properties: {
            id: uid,
            type: 'b-m-p-s-p-loc',
            how: 'm-g',
            callsign: camera.name,
            time: now.toISOString(),
            start: now.toISOString(),
            stale: new Date(now.getTime() + STALE_MS).toISOString(),
            center: [camera.lon, camera.lat],
            'marker-color': !camera.online ? OFFLINE_COLOR : (camera.video ? VIDEO_COLOR : STILL_COLOR),
            'marker-opacity': 1,
            remarks: remarks(camera, status),
            video: { url },
        },
        geometry: { type: 'Point', coordinates: [camera.lon, camera.lat] },
    } as InputFeature;
}

/** Big selections: the cameras in (or near) the map view, nearest the centre first, up to the cap */
function nearView(pinia: Pinia, cameras: Camera[]): Camera[] {
    const map = useMapStore(pinia).map;
    if (!map) return cameras.slice(0, MARKER_CAP);

    const b = map.getBounds();
    const padLon = (b.getEast() - b.getWest()) * VIEW_PAD;
    const padLat = (b.getNorth() - b.getSouth()) * VIEW_PAD;
    const c = map.getCenter();

    return cameras
        .filter((cam) => cam.lon >= b.getWest() - padLon && cam.lon <= b.getEast() + padLon
            && cam.lat >= b.getSouth() - padLat && cam.lat <= b.getNorth() + padLat)
        .map((cam) => ({ cam, d: (cam.lon - c.lng) ** 2 + (cam.lat - c.lat) ** 2 }))
        .sort((x, y) => x.d - y.d)
        .slice(0, MARKER_CAP)
        .map((x) => x.cam);
}

/**
 * Put the current camera list on the map (or take it off when hidden).
 * full = re-add every marker (new data); otherwise only add what is missing
 * (the map moved and only some cameras are shown).
 */
export async function syncCots(pinia: Pinia, full = true): Promise<void> {
    const db = useMapStore(pinia).worker.db;
    const keep = new Set<string>();

    let cameras = state.visible ? state.cameras.filter(passesFilter) : [];
    view.total = cameras.length;
    view.limited = cameras.length > MARKER_CAP;
    if (view.limited) cameras = nearView(pinia, cameras);

    const now = new Date();
    for (const camera of cameras) {
        const feat = feature(camera, now);
        if (!feat) continue;
        const uid = feat.id as string;
        keep.add(uid);
        if (!full && drawn.has(uid)) continue;
        try {
            await db.add(feat, { skipSave: true });
        } catch (err) {
            console.warn(`Cam Depot: could not add ${camera.id}`, err);
        }
    }

    drawn = keep;
    view.drawn = keep.size;
    await removeCots(pinia, keep);
}

/** The map moved: redraw only when big selections limit the markers to the view */
export async function viewChanged(pinia: Pinia): Promise<void> {
    if (view.limited && state.visible) await syncCots(pinia, false);
}

/** Redraw only the given cameras (their online/offline status changed) */
export async function updateCots(pinia: Pinia, cameras: Camera[]): Promise<void> {
    if (!state.visible) return;
    const db = useMapStore(pinia).worker.db;
    const now = new Date();

    for (const camera of cameras) {
        const feat = feature(camera, now);
        if (!feat) continue;
        // Big selections: leave cameras outside the drawn set to the next view redraw
        if (view.limited && !drawn.has(feat.id as string)) continue;
        try {
            if (passesFilter(camera)) {
                await db.add(feat, { skipSave: true });
            } else {
                // e.g. a camera went offline while "Video" is the filter
                await db.remove(feat.id as string, { skipNetwork: true });
            }
        } catch { /* try again on the next change */ }
    }
}

/** Remove our markers (including ones left from an earlier page load), except the ids in keep */
export async function removeCots(pinia: Pinia, keep: Set<string> = new Set()): Promise<void> {
    const db = useMapStore(pinia).worker.db;
    let ids: string[] = [];
    try {
        ids = await localDb.feature.where('id').startsWith(UID_PREFIX).primaryKeys();
    } catch { /* local store unavailable */ }

    for (const uid of ids) {
        if (keep.has(uid)) continue;
        try {
            await db.remove(uid, { skipNetwork: true });
        } catch { /* already gone */ }
    }
}
