/**
 * Cam Depot for CloudTAK - server routes
 *
 * An independent CloudTAK plugin inspired by takwerx's Cam Depot for ATAK.
 * Not made or supported by takwerx. Camera data: the Cam Depot catalog published
 * by TAKWERX, used with their permission (github.com/takwerx/cam-depot issue #9).
 *
 * - GET  /cam-depot/states                 States and provinces in the catalog (logged-in users)
 * - GET  /cam-depot/cameras?state=KS       Camera list for one state (logged-in users)
 * - POST /cam-depot/sync                   Check the catalog for changes (logged-in users, rate-limited)
 * - GET  /cam-depot/search?q=I-70          Find cameras in every state (logged-in users)
 * - GET  /cam-depot/status?state=KS        Offline cameras of one state (logged-in users); keeps the
 *                                          catalog status feed polled every 15 s while in use
 * - GET  /cam-depot/still/:camera.jpg      Current picture of a camera without its own picture
 *                                          link (no login: loaded by the video pane)
 *
 * The browser only ever talks to CloudTAK, so no Content-Security-Policy changes
 * are needed and hosts without CORS still work.
 */
import { gunzipSync } from 'node:zlib';
import { Type } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';

const FETCH_TIMEOUT_MS = 20 * 1000;
const USER_AGENT = 'Mozilla/5.0 (compatible; CamDepot-for-CloudTAK)';

function safeHttps(raw: unknown): URL | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// The Cam Depot catalog published by TAKWERX
// ---------------------------------------------------------------------------
//
// Used with TAKWERX's permission (github.com/takwerx/cam-depot issue #9), on
// their terms: the catalog is read at most once a day (or on a rate-limited
// Sync) with its ETag, state files are kept until the catalog changes, every
// host and stream address comes from the catalog, and an unknown catalog
// format is skipped quietly. Streams open only when a user picks a camera.

const CATALOG_URL = 'https://mapdepot.takwerx.org/camdepot/catalog.json';
const CATALOG_FORMAT = 1;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Sync: at most one catalog check per 10 min for the whole server */
const SYNC_GAP_MS = 10 * 60 * 1000;
/** ALERT West asks for no more than one picture per camera per 15 s */
const LIVE_STILL_MS = 15 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CATALOG_CREDIT = 'Camera data: Cam Depot (TAKWERX)';
/** Status feed: no faster than every 15 s, and only while a browser is showing cameras */
const STATUS_POLL_MS = 15 * 1000;
const STATUS_IDLE_MS = 60 * 1000;

const PLACE_NAMES: Record<string, string> = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
    LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
    NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
    OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
    SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const PROVINCE_NAMES: Record<string, string> = {
    AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
    NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut',
    ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};

type Provider = { id: string; attribution: string; license: string; licenseUrl: string };

type Catalog = {
    etag: string;
    generated: string;
    checkedAt: number;
    base: URL;
    imageLive: URL | null;
    /** Live status feed (online/offline), asked with ?since=<seq> */
    dynamicBase: URL | null;
    mjpegBase: string;
    imageHost: string;
    states: Map<string, { cameras: number; file: URL; images: URL | null; dynamic: URL | null }>;
    providers: Map<string, Provider>;
};

type CatalogCamera = {
    id: string;
    /** The catalog's own id, used for the live picture lookup */
    rawId: string;
    name: string;
    lat: number;
    lon: number;
    county: string;
    provider: string;
    still: string | null;
    /** No still link, but listed in the state's images file: picture from the live picture lookup */
    liveStill: boolean;
    stream: string | null;
    /** Wildfire camera */
    fire: boolean;
    /** Road or highway name, used by search */
    highway: string;
};

type StateFile = {
    generated: string;
    /** Catalog ids marked offline in the state's status file (as of the publish) */
    offline: Set<string>;
    cameras: CatalogCamera[];
    byId: Map<string, CatalogCamera>;
};

const catalogState: {
    catalog: Catalog | null;
    pending: Promise<void> | null;
    error: string | null;
    lastSync: number;
    files: Map<string, StateFile>;
    filePending: Map<string, Promise<StateFile>>;
    stills: Map<string, { at: number; type: string; body: Buffer | null; pending: Promise<void> | null }>;
} = {
    catalog: null,
    pending: null,
    error: null,
    lastSync: 0,
    files: new Map(),
    filePending: new Map(),
    stills: new Map(),
};

function placeName(st: string): string {
    return PLACE_NAMES[st] || PROVINCE_NAMES[st] || st;
}

async function fetchBytes(url: URL, headers: Record<string, string> = {}, limit = MAX_FILE_BYTES): Promise<{ status: number; body: Buffer; headers: Headers }> {
    const res = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, ...headers },
    });
    const length = Number(res.headers.get('content-length'));
    if (length > limit) throw new Error(`${url.hostname} sent a file that is too large`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > limit) throw new Error(`${url.hostname} sent a file that is too large`);
    return { status: res.status, body, headers: res.headers };
}

function readJson(body: Buffer): unknown {
    // State files are served as gzip files, not gzip-encoded responses
    const raw = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
    return JSON.parse(raw.toString('utf8'));
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

function parseCatalog(body: unknown, etag: string): Catalog {
    const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (o.format !== CATALOG_FORMAT) throw new Error(`catalog format ${String(o.format)} is not supported`);

    const base = new URL(CATALOG_URL);
    const imageLive = safeHttps(o.image_live);
    const imageBase = safeHttps(o.image_base);

    const states = new Map<string, { cameras: number; file: URL; images: URL | null; dynamic: URL | null }>();
    for (const s of Array.isArray(o.states) ? o.states : []) {
        const st = str(s?.st).toUpperCase();
        if (!/^[A-Z]{2}$/.test(st)) continue;
        let file: URL;
        let images: URL | null = null;
        let dynamic: URL | null = null;
        try {
            file = new URL(str(s.static) || `static/${st}.json.gz`, base);
            if (str(s.images)) images = new URL(str(s.images), base);
            if (str(s.dynamic)) dynamic = new URL(str(s.dynamic), base);
        } catch {
            continue;
        }
        if (file.protocol !== 'https:') continue;
        if (images && images.protocol !== 'https:') images = null;
        if (dynamic && dynamic.protocol !== 'https:') dynamic = null;
        states.set(st, { cameras: Number(s.cameras) || 0, file, images, dynamic });
    }
    if (!states.size) throw new Error('catalog lists no states');

    const providers = new Map<string, Provider>();
    for (const p of Array.isArray(o.providers) ? o.providers : []) {
        const id = str(p?.id);
        if (!id) continue;
        const licenseUrl = safeHttps(p.license_url) || (() => {
            // Some license links are plain http (e.g. creativecommons.org); keep them as links
            try {
                const u = new URL(str(p.license_url));
                return u.protocol === 'http:' ? u : null;
            } catch {
                return null;
            }
        })();
        providers.set(id, {
            id,
            attribution: str(p.attribution),
            license: str(p.license),
            licenseUrl: licenseUrl ? licenseUrl.href : '',
        });
    }

    return {
        etag,
        generated: str(o.generated),
        checkedAt: Date.now(),
        base,
        imageLive,
        dynamicBase: safeHttps(o.dynamic_base),
        mjpegBase: str(o.mjpeg_base),
        imageHost: imageBase ? imageBase.hostname : '',
        states,
        providers,
    };
}

/** Read the catalog: once a day, or when forced by a Sync. Failures keep the last good copy. */
async function ensureCatalog(force = false): Promise<Catalog | null> {
    const current = catalogState.catalog;
    if (current && !force && Date.now() - current.checkedAt < CATALOG_MAX_AGE_MS) return current;
    // A failed read is not retried for an hour, so a down catalog host isn't hammered
    if (!current && !force && catalogState.error && Date.now() - catalogState.lastSync < 60 * 60 * 1000) return null;

    if (!catalogState.pending) {
        catalogState.lastSync = Date.now();
        catalogState.pending = (async () => {
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (current && current.etag) headers['If-None-Match'] = current.etag;

            const res = await fetchBytes(new URL(CATALOG_URL), headers);
            if (res.status === 304 && current) {
                current.checkedAt = Date.now();
                catalogState.error = null;
                return;
            }
            if (res.status !== 200) throw new Error(`catalog returned HTTP ${res.status}`);

            const next = parseCatalog(readJson(res.body), res.headers.get('etag') || '');
            if (!current || current.etag !== next.etag || current.generated !== next.generated) {
                // A new catalog: state files are read again when next asked for
                catalogState.files.clear();
            }
            catalogState.catalog = next;
            catalogState.error = null;
        })().catch((err: unknown) => {
            catalogState.error = err instanceof Error ? err.message : String(err);
            if (catalogState.catalog) catalogState.catalog.checkedAt = Date.now();
            console.error(`Cam Depot: catalog not used: ${catalogState.error}`);
        }).finally(() => {
            catalogState.pending = null;
        });
    }

    await catalogState.pending;
    return catalogState.catalog;
}

function parseStateFile(st: string, body: unknown, catalog: Catalog, withImages: Set<string>, offline: Set<string>): StateFile {
    if (!Array.isArray(body)) throw new Error(`${st} camera file is not a list`);

    const cameras: CatalogCamera[] = [];
    const byId = new Map<string, CatalogCamera>();
    const mjpeg = catalog.mjpegBase;

    for (const c of body) {
        if (!c || typeof c !== 'object') continue;
        const rawId = str(c.id);
        const lat = Number(c.lat);
        const lon = Number(c.lon);
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(rawId)) continue;
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

        const still = safeHttps(c.still);
        const streamUrl = safeHttps(c.stream);
        // MJPEG links can't be played by CloudTAK's video player: picture only
        const stream = streamUrl && !(mjpeg && streamUrl.href.startsWith(mjpeg)) ? streamUrl.href : null;
        const liveStill = !still && !!catalog.imageLive && withImages.has(rawId);
        if (!still && !stream && !liveStill) continue;

        // A few catalog ids repeat (reported to TAKWERX); keep every camera
        let id = `cd.${st}.${rawId}`;
        for (let n = 2; byId.has(id); n++) id = `cd.${st}.${rawId}.${n}`;

        const camera: CatalogCamera = {
            id,
            rawId,
            name: (str(c.n) || str(c.h) || `Camera ${rawId}`).replace(/_/g, ' ').replace(/\s+/g, ' ').trim(),
            lat: Math.round(lat * 1e6) / 1e6,
            lon: Math.round(lon * 1e6) / 1e6,
            county: str(c.co),
            provider: str(c.pr),
            fire: Number(c.fire) === 1,
            highway: str(c.h),
            still: still ? still.href : null,
            liveStill,
            stream,
        };
        cameras.push(camera);
        byId.set(id, camera);
    }

    return { generated: catalog.generated, offline, cameras, byId };
}

/** A state's cameras, kept until the catalog changes */
async function catalogCameras(st: string): Promise<{ catalog: Catalog; file: StateFile }> {
    const catalog = await ensureCatalog();
    const entry = catalog ? catalog.states.get(st) : undefined;
    if (!catalog || !entry) throw new Err(404, null, 'No camera source for that state');

    const have = catalogState.files.get(st);
    if (have && have.generated === catalog.generated) return { catalog, file: have };

    let pending = catalogState.filePending.get(st);
    if (!pending) {
        pending = (async () => {
            const url = new URL(entry.file);
            // Keyed to the publish time so a CDN never hands back last night's file
            if (catalog.generated) url.searchParams.set('v', catalog.generated.replace(/[^0-9]/g, ''));
            const res = await fetchBytes(url);
            if (res.status !== 200) throw new Error(`${st} camera file returned HTTP ${res.status}`);

            // Which cameras the live picture lookup can answer for (same as the ATAK plugin)
            const withImages = new Set<string>();
            if (entry.images && catalog.imageLive) {
                try {
                    const imagesUrl = new URL(entry.images);
                    imagesUrl.search = url.search;
                    const img = await fetchBytes(imagesUrl);
                    if (img.status !== 200) throw new Error(`HTTP ${img.status}`);
                    const list = readJson(img.body);
                    if (list && typeof list === 'object' && !Array.isArray(list)) {
                        for (const id of Object.keys(list)) withImages.add(id);
                    }
                } catch (err) {
                    console.error(`Cam Depot: ${st} picture list failed, live pictures off: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            // Online/offline as of the publish; the live feed is laid on top
            const offline = new Set<string>();
            if (entry.dynamic) {
                try {
                    const dynUrl = new URL(entry.dynamic);
                    dynUrl.search = url.search;
                    const dyn = await fetchBytes(dynUrl);
                    if (dyn.status !== 200) throw new Error(`HTTP ${dyn.status}`);
                    const list = readJson(dyn.body);
                    for (const d of Array.isArray(list) ? list : []) {
                        if (d && typeof d === 'object' && Number(d.off) === 1) offline.add(str(d.id));
                    }
                } catch (err) {
                    console.error(`Cam Depot: ${st} status file failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const file = parseStateFile(st, readJson(res.body), catalog, withImages, offline);
            status.version++;
            catalogState.files.set(st, file);
            return file;
        })().finally(() => {
            catalogState.filePending.delete(st);
        });
        catalogState.filePending.set(st, pending);
    }

    try {
        return { catalog, file: await pending };
    } catch (err) {
        console.error(`Cam Depot: ${st} camera file failed: ${err instanceof Error ? err.message : String(err)}`);
        if (have) return { catalog, file: have };
        throw new Err(502, null, `Cameras for ${placeName(st)} are unavailable`);
    }
}

function cameraJson(st: string, file: StateFile, c: CatalogCamera) {
    return {
        id: c.id,
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        still: c.still || (c.liveStill ? `/api/cam-depot/still/${encodeURIComponent(c.id)}.jpg` : null),
        video: !!c.stream,
        stream: c.stream,
        online: !isOffline(st, file, c),
        provider: c.provider,
        county: c.county,
        fire: c.fire,
        state: st,
    };
}

const CameraJson = Type.Object({
    id: Type.String(),
    name: Type.String(),
    lat: Type.Number(),
    lon: Type.Number(),
    still: Type.Union([Type.String(), Type.Null()]),
    video: Type.Boolean(),
    stream: Type.Union([Type.String(), Type.Null()]),
    online: Type.Boolean(),
    provider: Type.String(),
    county: Type.String(),
    fire: Type.Boolean(),
    state: Type.String(),
});

// ---------------------------------------------------------------------------
// Search across every state: each state's files are read once per catalog
// publish (4 at a time), the first time anyone searches
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 50;
const searchState: { generated: string; running: Promise<void> | null } = { generated: '', running: null };

function loadAllStates(catalog: Catalog): void {
    if (searchState.running || searchState.generated === catalog.generated) return;
    const todo = [...catalog.states.keys()];
    searchState.running = (async () => {
        const worker = async () => {
            for (let st = todo.shift(); st; st = todo.shift()) {
                try {
                    await catalogCameras(st);
                } catch { /* logged by catalogCameras; that state is left out of search */ }
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        searchState.generated = catalog.generated;
    })().finally(() => {
        searchState.running = null;
    });
}

// ---------------------------------------------------------------------------
// Live status (online/offline): one poll of the catalog's status feed every 15 s
// for the whole server, and only while some browser has asked in the last minute
// ---------------------------------------------------------------------------

const status: {
    /** The feed's own change sequence */
    seq: number;
    /** Bumped on every change we see (and on every state file load) */
    version: number;
    /** `${state}:${catalog id}` -> offline, from the live feed */
    live: Map<string, boolean>;
    lastAsked: number;
    timer: ReturnType<typeof setInterval> | null;
    running: boolean;
} = { seq: 0, version: 1, live: new Map(), lastAsked: 0, timer: null, running: false };

function isOffline(st: string, file: StateFile, camera: CatalogCamera): boolean {
    const live = status.live.get(`${st}:${camera.rawId}`);
    return live !== undefined ? live : file.offline.has(camera.rawId);
}

async function pollStatus(): Promise<void> {
    if (Date.now() - status.lastAsked > STATUS_IDLE_MS) {
        if (status.timer) clearInterval(status.timer);
        status.timer = null;
        return;
    }
    const catalog = catalogState.catalog;
    if (!catalog || !catalog.dynamicBase || status.running) return;

    status.running = true;
    try {
        const url = new URL(catalog.dynamicBase);
        url.searchParams.set('since', String(status.seq));
        const res = await fetchBytes(url, { Accept: 'application/json' });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const body = readJson(res.body) as { seq?: unknown; cams?: unknown };
        const seq = Number(body.seq);
        if (!Number.isInteger(seq) || seq < 0) throw new Error('no sequence in the status feed');
        // The feed restarted: ask for everything next time
        if (seq < status.seq) {
            status.seq = 0;
            return;
        }

        let changed = false;
        for (const c of Array.isArray(body.cams) ? body.cams : []) {
            if (!c || typeof c !== 'object') continue;
            const key = `${str(c.st).toUpperCase()}:${str(c.id)}`;
            const off = Number(c.off) === 1;
            if (status.live.get(key) !== off) {
                status.live.set(key, off);
                changed = true;
            }
        }
        status.seq = seq;
        if (changed) status.version++;
    } catch (err) {
        console.error(`Cam Depot: status feed failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        status.running = false;
    }
}

/** A browser is showing cameras: keep (or start) the 15 s status poll */
function touchStatus(): void {
    status.lastAsked = Date.now();
    if (!status.timer) {
        status.timer = setInterval(() => {
            void pollStatus();
        }, STATUS_POLL_MS);
        status.timer.unref?.();
        void pollStatus();
    }
}

/** Current picture of a camera without a still link, at most one fetch per camera per 15 s */
async function liveStill(camera: CatalogCamera, catalog: Catalog): Promise<{ type: string; body: Buffer } | null> {
    let entry = catalogState.stills.get(camera.id);
    if (!entry) {
        entry = { at: 0, type: '', body: null, pending: null };
        catalogState.stills.set(camera.id, entry);
    }

    if (Date.now() - entry.at >= LIVE_STILL_MS && !entry.pending && catalog.imageLive) {
        const e = entry;
        e.pending = (async () => {
            const lookup = new URL(catalog.imageLive!);
            lookup.searchParams.set('id', camera.rawId);
            const res = await fetchBytes(lookup, { Accept: 'application/json' }, 64 * 1024);
            if (res.status !== 200) throw new Error(`picture lookup returned HTTP ${res.status}`);
            const frame = safeHttps((readJson(res.body) as { url?: unknown }).url);
            // Only ever fetch from the picture host the catalog names
            if (!frame || !catalog.imageHost || frame.hostname !== catalog.imageHost) throw new Error('unexpected picture host');

            const img = await fetchBytes(frame, { Accept: 'image/*' }, MAX_IMAGE_BYTES);
            const type = img.headers.get('content-type') || '';
            if (img.status !== 200 || !type.startsWith('image/')) throw new Error(`picture returned HTTP ${img.status}`);
            e.type = type;
            e.body = img.body;
        })().catch((err: unknown) => {
            console.error(`Cam Depot: picture for ${camera.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }).finally(() => {
            e.at = Date.now();
            e.pending = null;
        });
    }

    if (entry.pending) await entry.pending;

    // Forget pictures nobody has looked at for a while
    if (catalogState.stills.size > 500) {
        for (const [id, s] of catalogState.stills) {
            if (Date.now() - s.at > 10 * 60 * 1000) catalogState.stills.delete(id);
        }
    }

    return entry.body ? { type: entry.type, body: entry.body } : null;
}

export default async function router(schema: Schema, config: ConfigStateless) {
    await schema.get('/cam-depot/states', {
        name: 'Cam Depot States',
        group: 'CamDepot',
        description: 'States and provinces this server has traffic cameras for',
        res: Type.Object({
            catalog: Type.Object({
                available: Type.Boolean(),
                generated: Type.String(),
                credit: Type.String(),
            }),
            items: Type.Array(Type.Object({
                id: Type.String(),
                name: Type.String(),
                country: Type.String(),
                cameras: Type.Integer(),
            })),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const catalog = await ensureCatalog();
            const items = [...(catalog ? catalog.states : [])].map(([st, s]) => ({
                id: st,
                name: placeName(st),
                country: PROVINCE_NAMES[st] ? 'CA' : 'US',
                cameras: s.cameras,
            }));
            // United States first, then Canada, each by name
            items.sort((a, b) => b.country.localeCompare(a.country) || a.name.localeCompare(b.name));

            res.json({
                catalog: {
                    available: !!catalog,
                    generated: catalog ? catalog.generated : '',
                    credit: CATALOG_CREDIT,
                },
                items,
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/cam-depot/sync', {
        name: 'Cam Depot Sync',
        group: 'CamDepot',
        description: 'Check the camera catalog for changes (at most once per 10 minutes per server)',
        res: Type.Object({
            checked: Type.Boolean(),
            generated: Type.String(),
            available: Type.Boolean(),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            let checked = false;
            if (Date.now() - catalogState.lastSync >= SYNC_GAP_MS && !catalogState.pending) {
                await ensureCatalog(true);
                checked = true;
            }
            const catalog = catalogState.catalog;
            res.json({ checked, generated: catalog ? catalog.generated : '', available: !!catalog });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/cam-depot/cameras', {
        name: 'Cam Depot Cameras',
        group: 'CamDepot',
        description: 'Traffic cameras for one state or province',
        query: Type.Object({
            state: Type.String({ pattern: '^[A-Z]{2}$' }),
        }),
        res: Type.Object({
            state: Type.String(),
            version: Type.Integer(),
            attribution: Type.String(),
            updated: Type.String(),
            providers: Type.Array(Type.Object({
                id: Type.String(),
                attribution: Type.String(),
                license: Type.String(),
                license_url: Type.String(),
            })),
            items: Type.Array(CameraJson),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const { catalog, file } = await catalogCameras(req.query.state);
            const used = new Set(file.cameras.map(c => c.provider));
            const providers = [...used].map(id => catalog.providers.get(id))
                .filter((p): p is Provider => !!p && !!(p.attribution || p.license))
                .map(p => ({ id: p.id, attribution: p.attribution, license: p.license, license_url: p.licenseUrl }));

            touchStatus();
            res.json({
                state: req.query.state,
                version: status.version,
                attribution: CATALOG_CREDIT,
                updated: catalog.generated,
                providers,
                items: file.cameras.map(c => cameraJson(req.query.state, file, c)),
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/cam-depot/search', {
        name: 'Cam Depot Search',
        group: 'CamDepot',
        description: 'Find cameras by name, road or county in every state (loads every state file once per catalog publish)',
        query: Type.Object({
            q: Type.String({ minLength: 2, maxLength: 100 }),
            /** States the browser already searches itself, comma separated */
            exclude: Type.Optional(Type.String({ pattern: '^([A-Z]{2})?(,[A-Z]{2})*$' })),
        }),
        res: Type.Object({
            complete: Type.Boolean(),
            total: Type.Integer(),
            items: Type.Array(CameraJson),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const catalog = await ensureCatalog();
            if (!catalog) throw new Err(503, null, 'The camera catalog is unavailable');
            loadAllStates(catalog);

            const words = req.query.q.toLowerCase().split(/\s+/).filter(Boolean);
            const exclude = new Set((req.query.exclude || '').split(',').filter(Boolean));
            const items = [];
            let total = 0;

            for (const st of [...catalog.states.keys()].sort()) {
                const file = catalogState.files.get(st);
                if (exclude.has(st) || !file || file.generated !== catalog.generated) continue;
                for (const c of file.cameras) {
                    const text = `${c.name} ${c.highway} ${c.county} ${c.provider}`.toLowerCase();
                    if (!words.every(w => text.includes(w))) continue;
                    total++;
                    if (items.length < SEARCH_LIMIT) items.push(cameraJson(st, file, c));
                }
            }

            res.json({ complete: searchState.generated === catalog.generated && !searchState.running, total, items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/cam-depot/status', {
        name: 'Cam Depot Status',
        group: 'CamDepot',
        description: 'Offline cameras of one state; polled by the browser while cameras are on the map (keeps the 15 s status feed poll running)',
        query: Type.Object({
            state: Type.String({ pattern: '^[A-Z]{2}$' }),
            /** The version the browser last saw: unchanged = nothing to send */
            version: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        res: Type.Object({
            version: Type.Integer(),
            changed: Type.Boolean(),
            offline: Type.Array(Type.String()),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            touchStatus();
            if (req.query.version === status.version) {
                res.json({ version: status.version, changed: false, offline: [] });
                return;
            }

            const { file } = await catalogCameras(req.query.state);
            res.json({
                version: status.version,
                changed: true,
                offline: file.cameras.filter(c => isOffline(req.query.state, file, c)).map(c => c.id),
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/cam-depot/still/:camera.jpg', {
        name: 'Cam Depot Picture',
        group: 'CamDepot',
        description: 'Current picture of a catalog camera without its own picture link; no login (loaded by the video pane), known cameras only',
        params: Type.Object({
            camera: Type.String({ pattern: '^cd\\.[A-Z]{2}\\.[A-Za-z0-9._-]{1,70}$' }),
        }),
    }, async (req, res) => {
        try {
            const st = req.params.camera.split('.')[1];
            const catalog = await ensureCatalog();
            if (!catalog || !catalog.states.has(st)) throw new Err(404, null, 'Unknown camera');

            const { file } = await catalogCameras(st);
            const camera = file.byId.get(req.params.camera);
            if (!camera || !camera.liveStill) throw new Err(404, null, 'Unknown camera');

            const picture = await liveStill(camera, catalog);
            if (!picture) throw new Err(502, null, 'Picture unavailable');

            res.setHeader('Content-Type', picture.type);
            res.setHeader('Cache-Control', 'private, max-age=15');
            res.send(picture.body);
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
