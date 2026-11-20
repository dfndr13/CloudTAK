/**
 * Cam Depot for CloudTAK
 *
 * Public traffic cameras on the CloudTAK map: a side panel to find them, camera
 * CoT markers on the map (local only, never sent to TAK Server), and the radial
 * play button for the latest picture or live video.
 *
 * An independent CloudTAK plugin inspired by takwerx's Cam Depot for ATAK.
 * Not made or supported by takwerx. Camera data: the Cam Depot catalog by
 * TAKWERX, read through this server (api/stateless/routes/plugin-cam-depot.ts).
 */
import type { App } from 'vue';
import { markRaw } from 'vue';
import type { PluginAPI, PluginInstance, MenuItemConfig } from '../../plugin.ts';
import { IconVideo } from '@tabler/icons-vue';
import CamDepotPanel from './CamDepotPanel.vue';
import { loadCameras, onCamerasChanged, onStatusChanged, refreshStatus, state } from './lib/state.ts';
import { syncCots, updateCots, viewChanged } from './lib/cots.ts';
import { useMapStore } from '../../src/stores/map.ts';

const MENU_KEY = 'plugin-cam-depot';
const ROUTE_NAME = 'home-menu-cam-depot';
const RELOAD_MS = 5 * 60 * 1000;
/** Camera status: no faster than every 15 s (TAKWERX's limit) */
const STATUS_MS = 15 * 1000;

export default class CamDepotPlugin implements PluginInstance {
    api: PluginAPI;
    timer: ReturnType<typeof setInterval> | null = null;
    statusTimer: ReturnType<typeof setInterval> | null = null;
    unlisten: (() => void) | null = null;
    unlistenStatus: (() => void) | null = null;
    moveTimer: ReturnType<typeof setTimeout> | undefined;
    onMove = (): void => {
        // Wait for the map to settle before redrawing
        if (this.moveTimer) clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => { void viewChanged(this.api.pinia); }, 400);
    };

    constructor(api: PluginAPI) {
        this.api = api;
    }

    static async install(app: App, api: PluginAPI): Promise<CamDepotPlugin> {
        void app;
        api.routes.add(
            { path: 'cam-depot', name: ROUTE_NAME, component: CamDepotPanel },
            'home-menu'
        );
        return new CamDepotPlugin(api);
    }

    async enable(): Promise<void> {
        this.api.menu.add({
            key: MENU_KEY,
            label: 'Cam Depot',
            route: ROUTE_NAME,
            tooltip: 'Cam Depot for CloudTAK',
            description: 'Public traffic cameras: latest picture and live video',
            icon: markRaw(IconVideo) as unknown as MenuItemConfig['icon'],
        });

        this.unlisten = onCamerasChanged(() => { void syncCots(this.api.pinia); });
        this.unlistenStatus = onStatusChanged((cameras) => { void updateCots(this.api.pinia, cameras); });

        try {
            useMapStore(this.api.pinia).map.on('moveend', this.onMove);
        } catch { /* map not ready: big selections redraw on the next camera reload */ }

        // Load in the background; a failure shows in the panel, never blocks the map
        void loadCameras();
        this.timer = setInterval(() => { void loadCameras(true); }, RELOAD_MS);
        // Status only while cameras are on the map and the tab is in view
        this.statusTimer = setInterval(() => {
            if (!state.visible || !state.cameras.length || document.visibilityState !== 'visible') return;
            void refreshStatus();
        }, STATUS_MS);
    }

    async disable(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.statusTimer) clearInterval(this.statusTimer);
        this.statusTimer = null;
        if (this.moveTimer) clearTimeout(this.moveTimer);
        try {
            useMapStore(this.api.pinia).map.off('moveend', this.onMove);
        } catch { /* map gone */ }
        if (this.unlisten) this.unlisten();
        this.unlisten = null;
        if (this.unlistenStatus) this.unlistenStatus();
        this.unlistenStatus = null;
        try { this.api.menu.remove(MENU_KEY); } catch { /* ignore */ }
    }
}
