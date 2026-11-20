<template>
    <FloatingPane
        :uid='uid'
        :padded='false'
        class='video-container'
        @close='emit("close")'
    >
        <template #header>
            <StatusDot
                v-if='metadata'
                :status='metadata.active ? "success" : "unknown"'
                :dark='true'
                :title='metadata.active ? "Streaming" : "Unknown"'
                :size='24'
            />

            <VideoLeaseSourceType
                v-if='metadata && metadata.source_type'
                :source-type='metadata.source_type'
                :size='24'
            />

            <div
                class='mx-2'
                style='max-width: calc(100% - 100px);'
            >
                <div
                    class='text-sm text-truncate'
                    v-text='title'
                />
                <div
                    v-if='metadata && metadata.source_model'
                    class='subheader'
                    v-text='metadata.source_model'
                />
            </div>
        </template>

        <template #actions>
            <span
                v-if='metadata'
                class='watchers-info'
            >
                <IconUsersGroup
                    :size='24'
                    stroke='1'
                />
                <span v-text='metadata.watchers + 1' />
                <span
                    class='ms-1 watcher-text'
                    v-text='metadata.watchers + 1 > 1 ? "Watchers" : "Watcher"'
                />
            </span>

            <template v-if='!isNativePlatform() && !isImage'>
                <TablerIconButton
                    v-if='!pushing'
                    title='Push to Video Wall'
                    @click='pushToWall'
                >
                    <IconCast
                        :size='24'
                        stroke='1'
                    />
                </TablerIconButton>
                <TablerLoading
                    v-else
                    :inline='true'
                    desc='Pushing'
                />
            </template>
        </template>

        <div class='h-100 w-100 d-flex flex-column'>
            <TablerAlert
                v-if='pushError'
                class='w-100 mb-0'
                title='Video Wall Error'
                :compact='true'
                :err='pushError'
            />
            <div
                v-if='isImage'
                class='flex-grow-1 d-flex align-items-center justify-content-center bg-black'
            >
                <TablerAlert
                    v-if='imageError'
                    class='w-100 mb-0'
                    title='Still image unavailable'
                    :compact='true'
                    :err='new Error("The camera image could not be loaded")'
                />
                <img
                    v-else-if='imageSrc'
                    :src='imageSrc'
                    :alt='title'
                    style='max-width: 100%; max-height: 100%; object-fit: contain;'
                    @load='imageError = false'
                    @error='imageError = true'
                >
            </div>
            <VideoPlayer
                v-else
                class='flex-grow-1'
                :url='video.config.url'
                :lease='video.config.lease'
                @metadata='metadata = $event'
            />
        </div>
    </FloatingPane>
</template>

<script setup lang='ts'>
/**
 * FloatingVideo - draggable, resizable pane wrapping the unified VideoPlayer
 * with stream metadata and push-to-Video-Wall support.
 */

import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { server, getRuntimeToken } from '../../../std.ts';
import { proxyImageUrl, isImageLink } from './proxyImages.ts';
import StatusDot from './../../util/StatusDot.vue';
import VideoLeaseSourceType from './VideoLeaseSourceType.vue';
import FloatingPane from './FloatingPane.vue';
import VideoPlayer from '../../util/VideoPlayer.vue';
import type { VideoPlayerMetadata } from '../../util/VideoPlayer.vue';
import { notifyVideoWall, VIDEO_WALL_WINDOW } from '../../../lib/video-wall.ts';
import { isNativePlatform } from '../../../utils/capacitor.ts';
import { useFloatStore } from '../../../stores/float.ts';
import type { Pane, PaneVideoConfig } from '../../../stores/float.ts';
import {
    IconCast,
    IconUsersGroup,
} from '@tabler/icons-vue';
import {
    TablerAlert,
    TablerLoading,
    TablerIconButton,
} from '@tak-ps/vue-tabler';

const floatStore = useFloatStore();

const props = defineProps({
    title: {
        type: String,
        default: 'Video Stream'
    },
    uid: {
        type: String,
        required: true
    }
});

const emit = defineEmits(['close']);

const video = ref(floatStore.panes.get(props.uid) as Pane<PaneVideoConfig>);

const metadata = ref<VideoPlayerMetadata | undefined>();

// Still-image cameras (e.g. DOT snapshots) share the video play button but
// link a picture, not a stream - show it, refreshed, instead of the player
const STILL_REFRESH_MS = 15 * 1000;

const isImage = computed(() => {
    const url = video.value.config.url;
    return video.value.config.lease === undefined && !!url && isImageLink({ url });
});

const token = ref<string | null | undefined>(undefined);
const imageTick = ref(Date.now());
const imageError = ref(false);
let imageTimer: ReturnType<typeof setInterval> | undefined;

const imageSrc = computed(() => {
    if (!isImage.value || token.value === undefined) return;

    const url = new URL(video.value.config.url as string);
    url.searchParams.set('_', String(imageTick.value));

    return proxyImageUrl(url.href, token.value) ?? undefined;
});

onMounted(async () => {
    if (!isImage.value) return;

    token.value = (await getRuntimeToken()) ?? null;
    imageTimer = setInterval(() => {
        imageError.value = false;
        imageTick.value = Date.now();
    }, STILL_REFRESH_MS);
});

onBeforeUnmount(() => {
    if (imageTimer) clearInterval(imageTimer);
});

const pushing = ref(false);
const pushError = ref<Error | undefined>();

const title = computed(() => {
    if (metadata.value) {
        return metadata.value.name;
    } else {
        return video.value.name || props.title;
    }
});

/**
 * Save the stream to the user's Video Wall & focus the wall - opening
 * a new tab if no wall is currently open
 */
async function pushToWall(): Promise<void> {
    if (pushing.value) return;

    pushing.value = true;
    pushError.value = undefined;

    // Reserve/reuse the Video Wall window synchronously, inside this click's
    // user gesture, so the browser doesn't block window.open() once the
    // async work below resolves.
    const preOpened = window.open('', VIDEO_WALL_WINDOW);

    try {
        const { error } = await server.POST('/api/profile/video', {
            body: video.value.config.lease !== undefined ? {
                lease: video.value.config.lease,
                name: title.value
            } : {
                url: video.value.config.url,
                name: title.value
            }
        });

        if (error) throw new Error(error.message);

        await notifyVideoWall(preOpened);

        emit('close');
    } catch (err) {
        pushError.value = err instanceof Error ? err : new Error(String(err));
    } finally {
        pushing.value = false;
    }
}
</script>

<style>
.video-container {
    container-type: inline-size;
}

@container (max-width: 500px) {
    .watchers-info .watcher-text {
        display: none;
    }
}

@container (max-width: 450px) {
    .watchers-info {
        display: none !important;
    }
}
</style>
