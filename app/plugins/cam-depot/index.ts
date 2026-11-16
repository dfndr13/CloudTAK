/**
 * CloudTAK CAM Depot
 *
 * Public traffic cameras on the CloudTAK map: a side panel to find them, camera
 * CoT markers on the map (local only, never sent to TAK Server), and the radial
 * play button for the latest picture or live video.
 *
 * An independent CloudTAK plugin inspired by takwerx's Cam Depot for ATAK.
 * Not made or supported by takwerx. Camera data comes straight from each
 * agency's public API through this server (api/stateless/routes/plugin-cam-depot.ts).
 */
import type { App } from 'vue';
import { markRaw } from 'vue';
import type { PluginAPI, PluginInstance, MenuItemConfig } from '../../plugin.ts';
import { IconDeviceCctv } from '@tabler/icons-vue';
import CamDepotPanel from './CamDepotPanel.vue';
import { loadCameras, onCamerasChanged } from './lib/state.ts';
import { syncCots } from './lib/cots.ts';

const MENU_KEY = 'plugin-cam-depot';
const ROUTE_NAME = 'home-menu-cam-depot';
const RELOAD_MS = 5 * 60 * 1000;

export default class CamDepotPlugin implements PluginInstance {
    api: PluginAPI;
    timer: ReturnType<typeof setInterval> | null = null;
    unlisten: (() => void) | null = null;

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
            label: 'CAM Depot',
            route: ROUTE_NAME,
            tooltip: 'CloudTAK CAM Depot',
            description: 'Public traffic cameras: latest picture and live video',
            icon: markRaw(IconDeviceCctv) as unknown as MenuItemConfig['icon'],
        });

        this.unlisten = onCamerasChanged(() => { void syncCots(this.api.pinia); });

        // Load in the background; a failure shows in the panel, never blocks the map
        void loadCameras();
        this.timer = setInterval(() => { void loadCameras(true); }, RELOAD_MS);
    }

    async disable(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.unlisten) this.unlisten();
        this.unlisten = null;
        try { this.api.menu.remove(MENU_KEY); } catch { /* ignore */ }
    }
}
