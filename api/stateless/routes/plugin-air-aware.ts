/**
 * Air Aware: server side relay.
 *
 * The browser cannot read the data Air Aware draws: the takwerx map packs, the FAA TFR
 * service and aviationweather.gov either send no CORS headers or sit outside CloudTAK's
 * connect-src. This route fetches a fixed set of public, unauthenticated URLs on the
 * user's behalf, unpacks the gzip tiles and keeps a short in-memory cache so a busy
 * server does not hammer the sources. It never takes a URL from the client: every
 * upstream address is built here from validated path segments.
 *
 * One self-contained file on purpose. CloudTAK loads every file in
 * api/stateless/routes/ as a router, so helpers live in here.
 */
import { gunzipSync } from 'node:zlib';
import { Type } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';

const PACK_BASE = 'https://mapdepot.takwerx.org/airaware/';
const TFR_LIST = 'https://tfr.faa.gov/tfrapi/exportTfrList';
const TFR_DETAIL = 'https://tfr.faa.gov/download/detail_';
const METAR = 'https://aviationweather.gov/api/data/metar';

const TIMEOUT_MS = 20_000;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_INFLATED = 48 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 600;

const MINUTE = 60_000;

/** Each pack, its manifest file and how long a fetched copy is trusted. */
const PACKS: Record<string, { manifest: string; manifestTtl: number; tileTtl: number; files: string[] }> = {
    airspace: { manifest: 'airspace.json', manifestTtl: 360 * MINUTE, tileTtl: 720 * MINUTE, files: ['wide.json.gz'] },
    obstacles: { manifest: 'obstacles.json', manifestTtl: 360 * MINUTE, tileTtl: 720 * MINUTE, files: [] },
    uasfm: { manifest: 'uasfm.json', manifestTtl: 360 * MINUTE, tileTtl: 720 * MINUTE, files: [] },
    nsufr: { manifest: 'nsufr.json', manifestTtl: 60 * MINUTE, tileTtl: 360 * MINUTE, files: ['nsufr.json.gz'] },
    notams: { manifest: 'notams.json', manifestTtl: 3 * MINUTE, tileTtl: 3 * MINUTE, files: [] }
};

const TILE_KEY = /^-?\d{1,3}_-?\d{1,3}$/;
const NOTAM_ID = /^\d{1,4}_\d{1,6}$/;
const NUM = /^-?\d{1,3}(\.\d{1,6})?$/;

interface CacheEntry {
    at: number;
    ttl: number;
    value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

function cacheGet(key: string): unknown {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > hit.ttl) return undefined;
    // Re-insert so the Map's order works as an LRU.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
}

function cacheStale(key: string): unknown {
    return cache.get(key)?.value;
}

function cacheSet(key: string, ttl: number, value: unknown): void {
    cache.delete(key);
    cache.set(key, { at: Date.now(), ttl, value });
    while (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
    }
}

async function download(url: string): Promise<Buffer> {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'CloudTAK-AirAware/1.0', 'Accept': '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 404) throw new Err(404, null, 'Not published upstream');
    if (!res.ok) throw new Err(502, null, `Upstream answered ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_BODY) throw new Err(502, null, 'Upstream body too large');
    return body;
}

function parseJson(body: Buffer, gz: boolean): unknown {
    const text = gz
        ? gunzipSync(body, { maxOutputLength: MAX_INFLATED }).toString('utf8')
        : body.toString('utf8');
    return JSON.parse(text) as unknown;
}

/**
 * Fetch through the cache. A failed refresh hands back the last good copy, so a source
 * outage never empties a layer that was already drawn.
 */
async function cached(key: string, ttl: number, load: () => Promise<unknown>): Promise<unknown> {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;

    const pending = inflight.get(key);
    if (pending) return pending;

    const job = (async (): Promise<unknown> => {
        try {
            const value = await load();
            cacheSet(key, ttl, value);
            return value;
        } catch (err) {
            const stale = cacheStale(key);
            if (stale !== undefined) return stale;
            throw err;
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, job);
    return job;
}

function pack(name: string): { manifest: string; manifestTtl: number; tileTtl: number; files: string[] } {
    const p = PACKS[name];
    if (!p) throw new Err(400, null, 'Unknown pack');
    return p;
}

export default async function router(schema: Schema, config: ConfigStateless): Promise<void> {
    await schema.get('/plugin/air-aware/pack/:pack/manifest', {
        name: 'Air Aware Pack Manifest',
        group: 'AirAware',
        description: 'The manifest of one Air Aware data pack (airspace, obstacles, uasfm, nsufr, notams)',
        params: Type.Object({
            pack: Type.String()
        }),
        res: Type.Any()
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const p = pack(req.params.pack);
            const url = PACK_BASE + req.params.pack + '/' + p.manifest;
            res.json(await cached(url, p.manifestTtl, async () => parseJson(await download(url), false)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/plugin/air-aware/pack/:pack/tile/:key', {
        name: 'Air Aware Pack Tile',
        group: 'AirAware',
        description: 'One two-degree tile of an Air Aware data pack, unpacked to JSON',
        params: Type.Object({
            pack: Type.String(),
            key: Type.String()
        }),
        res: Type.Any()
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const p = pack(req.params.pack);
            if (!TILE_KEY.test(req.params.key)) throw new Err(400, null, 'Bad tile key');
            const url = PACK_BASE + req.params.pack + '/tiles/' + req.params.key + '.json.gz';
            res.json(await cached(url, p.tileTtl, async () => parseJson(await download(url), true)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/plugin/air-aware/pack/:pack/file/:file', {
        name: 'Air Aware Pack File',
        group: 'AirAware',
        description: 'A single-file part of an Air Aware data pack (airspace wide areas, the NSUFR pack)',
        params: Type.Object({
            pack: Type.String(),
            file: Type.String()
        }),
        res: Type.Any()
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const p = pack(req.params.pack);
            const file = req.params.file + '.json.gz';
            if (!p.files.includes(file)) throw new Err(400, null, 'Unknown pack file');
            const url = PACK_BASE + req.params.pack + '/' + file;
            res.json(await cached(url, p.tileTtl, async () => parseJson(await download(url), true)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/plugin/air-aware/tfr', {
        name: 'Air Aware TFR List',
        group: 'AirAware',
        description: 'The FAA national list of Temporary Flight Restrictions',
        res: Type.Any()
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            res.json(await cached(TFR_LIST, 5 * MINUTE, async () => parseJson(await download(TFR_LIST), false)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/plugin/air-aware/tfr/:id', {
        name: 'Air Aware TFR Detail',
        group: 'AirAware',
        description: 'One TFR detail document (FAA XNOTAM XML), NOTAM id with the slash as an underscore',
        params: Type.Object({
            id: Type.String()
        }),
        res: Type.Object({
            id: Type.String(),
            xml: Type.String()
        })
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            if (!NOTAM_ID.test(req.params.id)) throw new Err(400, null, 'Bad NOTAM id');
            const url = TFR_DETAIL + req.params.id + '.xml';
            const xml = await cached(url, 10 * MINUTE, async () => (await download(url)).toString('utf8'));
            res.json({ id: req.params.id, xml: String(xml) });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/plugin/air-aware/metar', {
        name: 'Air Aware METARs',
        group: 'AirAware',
        description: 'METAR observations inside a bounding box from aviationweather.gov',
        query: Type.Object({
            south: Type.String(),
            west: Type.String(),
            north: Type.String(),
            east: Type.String()
        }),
        res: Type.Any()
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req);
            const { south, west, north, east } = req.query;
            for (const v of [south, west, north, east]) {
                if (!NUM.test(v)) throw new Err(400, null, 'Bad bounding box');
            }
            const s = Number(south), w = Number(west), n = Number(north), e = Number(east);
            if (n - s > 12 || e - w > 16 || n <= s || e <= w) throw new Err(400, null, 'Bounding box too large');
            // Rounded to a tenth of a degree so neighbouring requests share a cache entry.
            const r = (x: number): string => (Math.round(x * 10) / 10).toFixed(1);
            const url = `${METAR}?bbox=${r(s)},${r(w)},${r(n)},${r(e)}&format=json`;
            res.json(await cached(url, 5 * MINUTE, async () => {
                const body = await download(url);
                return body.length ? parseJson(body, false) : [];
            }));
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
