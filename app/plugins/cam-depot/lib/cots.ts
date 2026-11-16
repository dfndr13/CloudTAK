/**
 * CloudTAK CAM Depot - cameras as local CoT markers
 *
 * Each camera is added to CloudTAK's own feature store as a CoT, so it gets the
 * normal click/radial menu, and the radial play button opens its picture or
 * video (`video.url`). They are added the way CloudTAK adds CoT received from
 * the server: never archived, so CloudTAK never sends them to TAK Server. A
 * stale time keeps them from outliving the plugin; they are refreshed on every
 * camera reload.
 */
import type { Pinia } from 'pinia';
import { useMapStore } from '../../../src/stores/map.ts';
import { db as localDb } from '../../../src/database.ts';
import type { InputFeature } from '../../../src/types.ts';
import { state } from './state.ts';
import type { Camera } from './state.ts';
import { relayUrl } from './open.ts';

export const UID_PREFIX = 'cam-depot-';
const STALE_MS = 15 * 60 * 1000;

// No custom icon: CloudTAK draws its built-in icon for the camera CoT type
// (b-m-p-s-p-loc, same as the Node-RED KDOT feed), recoloured by marker-color
export const VIDEO_COLOR = '#2fb344';
export const STILL_COLOR = '#4299e1';
export const OFFLINE_COLOR = '#868e96';

function feature(camera: Camera, now: Date): InputFeature | null {
    const url = camera.video ? relayUrl(camera) : camera.still;
    if (!url) return null;

    const uid = UID_PREFIX + camera.id;
    const status = !camera.online ? 'Offline: the agency reports no current picture' : (camera.video ? 'Live video' : 'Picture only');

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
            remarks: `${status}\nSource: ${state.attribution || 'agency'} (CloudTAK CAM Depot)`,
            video: { url },
        },
        geometry: { type: 'Point', coordinates: [camera.lon, camera.lat] },
    } as InputFeature;
}

/** Put the current camera list on the map (or take it off when hidden) */
export async function syncCots(pinia: Pinia): Promise<void> {
    const db = useMapStore(pinia).worker.db;
    const keep = new Set<string>();

    if (state.visible) {
        const now = new Date();
        for (const camera of state.cameras) {
            const feat = feature(camera, now);
            if (!feat) continue;
            keep.add(feat.id as string);
            try {
                await db.add(feat, { skipSave: true });
            } catch (err) {
                console.warn(`CAM Depot: could not add ${camera.id}`, err);
            }
        }
    }

    await removeCots(pinia, keep);
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
