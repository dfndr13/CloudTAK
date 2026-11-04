/**
 * Module-scoped plugin state — the same reasoning as the measure plugin's lib/state.ts: plugins
 * share one Vite bundle and one runtime, so a module singleton is the simplest way for the
 * bottom-bar toggle, the search bar, and the gear panel to talk to the same Worker client without
 * prop-plumbing through the core component tree.
 *
 * Not covered by this repo's own tsconfig.json (see its `exclude`) — it imports `vue`/`pinia`,
 * which resolve against api/web's own node_modules at bundle time and aren't devDependencies
 * here, matching the measure plugin's zero-runtime-deps convention. Verified only via the
 * copy-into-CloudTAK + vue-tsc step.
 */
import { ref, shallowRef } from "vue";
import type { Pinia } from "pinia";
import type { PluginAPI } from "../../../plugin.ts";
import { SearchWorkerClient } from "./worker/worker-client.ts";

export const pinia = shallowRef<Pinia | null>(null);
export const api = shallowRef<PluginAPI | null>(null);
export const expanded = ref(false);
export const workerClient = shallowRef<SearchWorkerClient | null>(null);
/** CloudTAK system admin (profile `system_admin`). Only admins see the manual load controls;
 *  everyone else gets packs from the server's pack list only (lib/managed-packs.ts). */
export const isAdmin = ref(false);
/** Set while a managed-pack download runs — drives the status line in the search bar. */
export const managedStatus = ref<{ label: string; packIndex: number; packTotal: number; sectionsDone: number; sectionsTotal: number } | null>(null);
/** Bumped whenever datasets change outside the UI (a managed sync), so open panels re-list. */
export const datasetsVersion = ref(0);

export function open(): void {
    expanded.value = true;
}

export function close(): void {
    expanded.value = false;
}

export function toggle(): void {
    expanded.value = !expanded.value;
}
