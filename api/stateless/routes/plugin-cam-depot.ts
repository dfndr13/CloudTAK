/**
 * CloudTAK CAM Depot - server routes
 *
 * An independent CloudTAK plugin inspired by takwerx's Cam Depot for ATAK.
 * Not made or supported by takwerx.
 *
 * - GET /cam-depot/states                     States this server has a camera source for
 * - GET /cam-depot/cameras?state=KS           Camera list for one state (logged-in users)
 * - GET /cam-depot/hls/:camera/:type.m3u8     HLS relay for agency streams whose links
 *                                             carry short-lived tokens
 *
 * Each state has one source adapter that reads the agency's own public API. The
 * browser only ever talks to CloudTAK, so no Content-Security-Policy changes are
 * needed and agency APIs without CORS still work.
 *
 * HLS relay: some agencies (e.g. KDOT) sign every stream link with a token that
 * expires minutes after it is issued, and playback stops when it does. The relay
 * gives each camera a fixed URL; every playlist request fetches the agency's
 * playlist with the newest token and returns it with absolute agency URLs, so the
 * video segments still come straight from the agency. CloudTAK's media server
 * fetches this URL without a user login, so it only answers for known camera ids
 * and only ever contacts the adapter's allowlisted stream hosts.
 */
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';

const REFRESH_MS = 60 * 1000;
/** Picture health sweep: at most every 10 min, one request at a time, only while someone uses the plugin */
const HEALTH_MS = 10 * 60 * 1000;
const HEALTH_GAP_MS = 250;
const FETCH_TIMEOUT_MS = 20 * 1000;
const USER_AGENT = 'Mozilla/5.0 (compatible; CloudTAK-CAM-Depot)';

type Camera = {
    id: string;
    name: string;
    lat: number;
    lon: number;
    still: string | null;
    video: boolean;
    /** false = the agency serves an error or its "camera offline" card for the picture */
    online: boolean;
};

type SourceCamera = Camera & {
    /** Tokened HLS master playlist - server side only, never sent to the browser */
    stream: string | null;
};

type Adapter = {
    state: string;
    name: string;
    attribution: string;
    /** Hostname suffixes the HLS relay may fetch from */
    streamHosts: string[];
    /** Agency "camera offline" cards: same size + md5 = offline */
    placeholders: Array<{ host: string; length: number; md5: string }>;
    load: () => Promise<SourceCamera[]>;
};

function safeHttps(raw: unknown): URL | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

function hostAllowed(url: URL, suffixes: string[]): boolean {
    return url.protocol === 'https:' && suffixes.some((s) => url.hostname === s || url.hostname.endsWith(`.${s}`));
}

async function fetchText(url: string | URL, init: RequestInit = {}): Promise<{ status: number; text: string; url: string }> {
    const res = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
    });
    return { status: res.status, text: await res.text(), url: res.url || String(url) };
}

// ---------------------------------------------------------------------------
// Kansas - KDOT KanDrive public GraphQL API
// ---------------------------------------------------------------------------

const KANDRIVE_QUERY = 'query MapFeatures($input: MapFeaturesArgs!) { mapFeaturesQuery(input: $input) { mapFeatures { bbox title uri __typename ... on Camera { active views(limit: 5) { uri ... on CameraView { url sources { type src } } } } } error { message type } } }';

type KanDriveFeature = {
    __typename?: string;
    bbox?: number[];
    title?: string;
    uri?: string;
    active?: boolean;
    views?: Array<{ uri?: string; url?: string | null; sources?: Array<{ type?: string; src?: string }> | null }>;
};

const kansas: Adapter = {
    state: 'KS',
    name: 'Kansas',
    attribution: 'Kansas Department of Transportation (KanDrive)',
    streamHosts: ['skyvdn.com'],
    placeholders: [
        // KC Scout "Last camera image missing. Please re-try in a few minutes."
        { host: 'www.kcscout.net', length: 11108, md5: 'd0304d12c31494b1d683702f49e4d4c8' },
    ],
    load: async () => {
        const res = await fetchText('https://www.kandrive.gov/api/graphql', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                query: KANDRIVE_QUERY,
                variables: {
                    input: {
                        north: 40.1, south: 36.9, east: -94.5, west: -102.1,
                        zoom: 10,
                        layerSlugs: ['normalCameras'],
                        nonClusterableUris: ['cms-dashboard/1'],
                    },
                },
            }),
        });
        if (res.status !== 200) throw new Error(`KanDrive returned HTTP ${res.status}`);

        const body = JSON.parse(res.text) as { data?: { mapFeaturesQuery?: { mapFeatures?: KanDriveFeature[] } } };
        const features = body.data?.mapFeaturesQuery?.mapFeatures || [];

        const cameras: SourceCamera[] = [];
        for (const f of features) {
            if (f.__typename !== 'Camera' || !f.active || !f.views || !f.views.length) continue;
            const num = String(f.uri || '').split('/')[1];
            if (!/^\d{1,7}$/.test(num)) continue;
            const bbox = f.bbox;
            if (!Array.isArray(bbox) || bbox.length < 4 || !bbox.every((n) => Number.isFinite(n))) continue;

            f.views.forEach((view, i) => {
                const still = safeHttps(view.url);
                const src = view.sources && view.sources.length ? safeHttps(view.sources[0].src) : null;
                const stream = src && hostAllowed(src, kansas.streamHosts) ? src.href : null;
                if (!still && !stream) return;

                cameras.push({
                    id: `KS-${num}${i > 0 ? `-${i}` : ''}`,
                    name: String(f.title || `Camera ${num}`) + (f.views!.length > 1 ? ` (view ${i + 1})` : ''),
                    lon: Math.round(((bbox[0] + bbox[2]) / 2) * 1e6) / 1e6,
                    lat: Math.round(((bbox[1] + bbox[3]) / 2) * 1e6) / 1e6,
                    still: still ? still.href : null,
                    video: !!stream,
                    online: true,
                    stream,
                });
            });
        }

        return cameras;
    },
};

const ADAPTERS: Record<string, Adapter> = {
    [kansas.state]: kansas,
};

// ---------------------------------------------------------------------------
// Cache - refreshed on demand at most once a minute per state, one load at a time
// ---------------------------------------------------------------------------

type CacheEntry = {
    updated: number;
    cameras: SourceCamera[];
    byId: Map<string, SourceCamera>;
    pending: Promise<void> | null;
    error: string | null;
    /** Picture URLs found offline in the last sweep */
    offline: Set<string>;
    healthAt: number;
    healthRunning: boolean;
};

const cache = new Map<string, CacheEntry>();

async function camerasFor(adapter: Adapter): Promise<CacheEntry> {
    let entry = cache.get(adapter.state);
    if (!entry) {
        entry = { updated: 0, cameras: [], byId: new Map(), pending: null, error: null, offline: new Set(), healthAt: 0, healthRunning: false };
        cache.set(adapter.state, entry);
    }

    if (Date.now() - entry.updated > REFRESH_MS) {
        if (!entry.pending) {
            const e = entry;
            e.pending = adapter.load().then((cameras) => {
                // An empty answer looks like an upstream failure - keep the last good list
                if (cameras.length === 0 && e.cameras.length > 0) throw new Error('Source returned no cameras');
                for (const c of cameras) c.online = !(c.still && e.offline.has(c.still));
                e.cameras = cameras;
                e.byId = new Map(cameras.map((c) => [c.id, c]));
                e.updated = Date.now();
                e.error = null;
            }).catch((err: unknown) => {
                e.error = err instanceof Error ? err.message : String(err);
                console.error(`CAM Depot: ${adapter.state} source failed: ${e.error}`);
            }).finally(() => {
                e.pending = null;
            });
        }
        await entry.pending;
    }

    if (!entry.cameras.length) throw new Err(502, null, `Camera source for ${adapter.name} is unavailable`);
    return entry;
}

async function stillOnline(adapter: Adapter, still: string): Promise<boolean> {
    try {
        const url = new URL(still);
        const head = await fetch(url, {
            method: 'HEAD',
            redirect: 'error',
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { 'User-Agent': USER_AGENT },
        });
        if (!head.ok) return false;
        if (!(head.headers.get('content-type') || 'image/').startsWith('image/')) return false;

        const length = Number(head.headers.get('content-length'));
        const suspects = adapter.placeholders.filter((p) => p.host === url.hostname && p.length === length);
        if (!suspects.length) return true;

        // Same size as a known "offline" card - compare the bytes
        const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': USER_AGENT } });
        const md5 = createHash('md5').update(Buffer.from(await res.arrayBuffer())).digest('hex');
        return !suspects.some((p) => p.md5 === md5);
    } catch {
        // A timeout or network error is not proof the camera is down
        return true;
    }
}

/** Check every picture one at a time in the background; results show on the next list load */
function sweepHealth(adapter: Adapter, entry: CacheEntry): void {
    if (entry.healthRunning || Date.now() - entry.healthAt < HEALTH_MS) return;
    entry.healthRunning = true;

    void (async () => {
        const offline = new Set<string>();
        const stills = [...new Set(entry.cameras.map((c) => c.still).filter((s): s is string => !!s))];
        for (const still of stills) {
            if (!(await stillOnline(adapter, still))) offline.add(still);
            await new Promise((resolve) => setTimeout(resolve, HEALTH_GAP_MS));
        }
        entry.offline = offline;
        for (const c of entry.cameras) c.online = !(c.still && offline.has(c.still));
    })().catch((err: unknown) => {
        console.error(`CAM Depot: ${adapter.state} health sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
        entry.healthAt = Date.now();
        entry.healthRunning = false;
    });
}

function adapterForCamera(id: string): Adapter | undefined {
    const state = id.split('-')[0];
    return Object.prototype.hasOwnProperty.call(ADAPTERS, state) ? ADAPTERS[state] : undefined;
}

function rewriteUris(line: string, base: string): string {
    return line.replace(/URI="([^"]+)"/g, (_m, uri: string) => `URI="${new URL(uri, base).href}"`);
}

export default async function router(schema: Schema, config: ConfigStateless) {
    await schema.get('/cam-depot/states', {
        name: 'CAM Depot States',
        group: 'CAMDepot',
        description: 'States this server has a traffic-camera source for',
        res: Type.Object({
            items: Type.Array(Type.Object({
                id: Type.String(),
                name: Type.String(),
                attribution: Type.String(),
            })),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            res.json({
                items: Object.values(ADAPTERS).map((a) => ({ id: a.state, name: a.name, attribution: a.attribution })),
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/cam-depot/cameras', {
        name: 'CAM Depot Cameras',
        group: 'CAMDepot',
        description: 'Traffic cameras for one state',
        query: Type.Object({
            state: Type.String({ pattern: '^[A-Z]{2}$' }),
        }),
        res: Type.Object({
            state: Type.String(),
            attribution: Type.String(),
            updated: Type.String(),
            items: Type.Array(Type.Object({
                id: Type.String(),
                name: Type.String(),
                lat: Type.Number(),
                lon: Type.Number(),
                still: Type.Union([Type.String(), Type.Null()]),
                video: Type.Boolean(),
                online: Type.Boolean(),
            })),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);

            const adapter = Object.prototype.hasOwnProperty.call(ADAPTERS, req.query.state) ? ADAPTERS[req.query.state] : undefined;
            if (!adapter) throw new Err(404, null, 'No camera source for that state');

            const entry = await camerasFor(adapter);
            sweepHealth(adapter, entry);

            res.json({
                state: adapter.state,
                attribution: adapter.attribution,
                updated: new Date(entry.updated).toISOString(),
                items: entry.cameras.map((c) => ({
                    id: c.id, name: c.name, lat: c.lat, lon: c.lon, still: c.still, video: c.video, online: c.online,
                })),
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/cam-depot/hls/:camera/:type.m3u8', {
        name: 'CAM Depot HLS Relay',
        group: 'CAMDepot',
        description: 'Fixed HLS playlist for a camera whose agency stream links expire; no login (fetched by the media server)',
        params: Type.Object({
            camera: Type.String({ pattern: '^[A-Z]{2}-[0-9]{1,7}(-[0-9])?$' }),
            type: Type.Union([Type.Literal('playlist'), Type.Literal('chunklist')]),
        }),
        query: Type.Object({
            v: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
        }),
    }, async (req, res) => {
        try {
            const adapter = adapterForCamera(req.params.camera);
            if (!adapter) throw new Err(404, null, 'Unknown camera');

            const entry = await camerasFor(adapter);
            const camera = entry.byId.get(req.params.camera);
            if (!camera || !camera.stream) throw new Err(404, null, 'Unknown camera');

            const master = await fetchText(camera.stream);
            if (master.status !== 200 || !master.text.startsWith('#EXTM3U')) {
                throw new Err(502, null, `Agency stream unavailable (HTTP ${master.status})`);
            }

            const lines = master.text.split(/\r?\n/);
            let body: string;

            if (req.params.type === 'playlist') {
                let n = 0;
                body = lines.map((line) => {
                    if (!line) return line;
                    if (line.startsWith('#')) return rewriteUris(line, camera.stream!);
                    return `chunklist.m3u8?v=${n++}`;
                }).join('\n');
            } else {
                const variants = lines.filter((l) => l && !l.startsWith('#'));
                const variant = variants[req.query.v || 0];
                if (!variant) throw new Err(404, null, 'Unknown variant');

                const next = new URL(variant, camera.stream);
                if (!hostAllowed(next, adapter.streamHosts)) throw new Err(502, null, 'Unexpected stream host');

                const chunk = await fetchText(next);
                if (chunk.status !== 200 || !chunk.text.startsWith('#EXTM3U')) {
                    throw new Err(502, null, `Agency stream unavailable (HTTP ${chunk.status})`);
                }

                body = chunk.text.split(/\r?\n/).map((line) => {
                    if (!line) return line;
                    if (line.startsWith('#')) return rewriteUris(line, next.href);
                    return new URL(line, next.href).href;
                }).join('\n');
            }

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-store');
            res.send(body);
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
