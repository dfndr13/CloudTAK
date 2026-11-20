/**
 * Cam Depot for CloudTAK - open a camera in CloudTAK's floating video pane
 *
 * The pane is the same one the radial play button opens: a picture URL shows as
 * a still (refreshed by the pane), anything else plays through a temporary
 * video lease, which CloudTAK deletes when the pane closes (so the stream stops).
 * Video uses the stream link the catalog gives (TAKWERX's relay handles links
 * with expiring tokens).
 */
import { defineAsyncComponent } from 'vue';
import type { Pinia } from 'pinia';
import { useFloatStore, VideoStoreType } from '../../../src/stores/float.ts';
import type { Camera } from './state.ts';

const FloatingVideo = defineAsyncComponent(() => import('../../../src/components/CloudTAK/util/FloatingVideo.vue'));

/** Video URL: the catalog's own stream link */
export function videoUrl(camera: Camera): string | null {
    return camera.video ? camera.stream : null;
}

export function openCamera(pinia: Pinia, camera: Camera, mode: 'video' | 'still' = camera.video ? 'video' : 'still'): void {
    const url = mode === 'video' && camera.video ? videoUrl(camera) : camera.still;
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
