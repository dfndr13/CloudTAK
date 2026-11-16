/**
 * CloudTAK CAM Depot - open a camera in CloudTAK's floating video pane
 *
 * The pane is the same one the radial play button opens: a picture URL shows as
 * a still (refreshed by the pane), anything else plays through a temporary
 * video lease. Agency streams go through this server's HLS relay so links with
 * expiring tokens keep playing.
 */
import { defineAsyncComponent } from 'vue';
import type { Pinia } from 'pinia';
import { stdurl } from '../../../src/std.ts';
import { useFloatStore, VideoStoreType } from '../../../src/stores/float.ts';
import type { Camera } from './state.ts';

const FloatingVideo = defineAsyncComponent(() => import('../../../src/components/CloudTAK/util/FloatingVideo.vue'));

export function relayUrl(camera: Camera): string {
    return stdurl(`/api/cam-depot/hls/${encodeURIComponent(camera.id)}/playlist.m3u8`).href;
}

export function openCamera(pinia: Pinia, camera: Camera, mode: 'video' | 'still' = camera.video ? 'video' : 'still'): void {
    const url = mode === 'video' && camera.video ? relayUrl(camera) : camera.still;
    if (!url) return;

    const floatStore = useFloatStore(pinia);
    const uid = `cam-depot-${camera.id}-${mode}`;

    // A second click on an open camera leaves it where the user put it
    if (floatStore.panes.has(uid)) return;

    floatStore.add({
        uid,
        name: camera.name,
        component: FloatingVideo,
        config: {
            type: VideoStoreType.COT,
            url,
        },
    });
}
