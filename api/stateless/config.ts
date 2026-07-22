import Config from '../common/config.js';
import type { ConfigArgs, ConfigInit } from '../common/config.js';
import RemoteHub from './lib/hub/remote.js';
import { UserManager } from './lib/interface-user.js';
import { WeatherManager } from './lib/interface-weather.js';
import type { HubClient } from '../common/hub/index.js';
import type Recorder from '../stateful/lib/replay-recorder.js';

/**
 * Configuration for the stateless half of the server ('both' and 'api'
 * modes): owns the services request handling needs. The hub client is a
 * RemoteHub against CLOUDTAK_Hub_URL in 'api' mode; in 'both' mode the caller
 * passes the co-located ConfigStateful's LocalHub instead.
 */
export default class ConfigStateless extends Config {
    hub: HubClient;
    user: UserManager;
    weather: WeatherManager;
    // Pragmatic direct reference to the co-located ConfigStateful's Recorder,
    // passed the same way `hub` is - only present in 'both' mode (undefined
    // in standalone 'api' mode, since Recorder's tap into ConnectionPool.cots()
    // only exists in the stateful process and there's no RPC equivalent for
    // recording control). Routes using this (api/stateless/routes/replay.ts)
    // must handle it being undefined.
    recorder?: Recorder;

    constructor(init: ConfigInit, opts: {
        hub?: HubClient;
        recorder?: Recorder;
    } = {}) {
        super(init);

        if (opts.hub) {
            this.hub = opts.hub;
        } else {
            if (!init.hubUrl) throw new Error('CLOUDTAK_Hub_URL must be set when CLOUDTAK_Server_Mode is api');
            this.hub = new RemoteHub(this, init.hubUrl);
        }

        this.recorder = opts.recorder;

        this.user = new UserManager(this);
        this.weather = new WeatherManager();
    }

    static async env(args: ConfigArgs, opts: {
        hub?: HubClient;
        recorder?: Recorder;
    } = {}): Promise<ConfigStateless> {
        const config = new ConfigStateless(await Config.envInit(args), opts);

        await config.user.init();

        return config;
    }
}
