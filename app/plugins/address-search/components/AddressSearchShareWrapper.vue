<!--
    api.float.add() only v-binds props onto whatever component it's given (see
    FloatingGeneric.vue: `v-bind='pane.config._props || {}'`, no listeners) — it never wires up a
    mounted component's own emits. Core's own Share.vue emits `close`/`done` from its header X and
    its Share/Broadcast buttons expecting a listener, but floated through the plugin API those
    emits go nowhere: clicking its X is a dead click and the pane never closes. Rather than edit
    CloudTAK core's FloatingGeneric.vue (not ours to change), this plugin floats THIS wrapper
    instead of ShareModal directly — it listens for both emits itself and removes the pane.
-->
<template>
    <ShareModal
        :feats='featsForShare'
        @close='finish'
        @done='finish'
    />
</template>

<script setup lang='ts'>
import { computed } from 'vue';
import { ShareModal } from '../lib/core-bridge.ts';
import { api } from '../lib/state.ts';

const SHARE_FLOAT_UID = 'address-search-share';

const props = defineProps<{ feats: Record<string, unknown>[] }>();

// ShareModal's real prop type is core's own `Feature[]` — deliberately not imported here (every
// deep core import is confined to lib/core-bridge.ts per docs/PLAN.md §9.1); our own feature
// shape is structurally compatible, so this is a boundary cast, not a real type mismatch.
const featsForShare = computed(() => props.feats as unknown[] as never[]);

function finish(): void {
    api.value?.float.remove(SHARE_FLOAT_UID);
}
</script>
