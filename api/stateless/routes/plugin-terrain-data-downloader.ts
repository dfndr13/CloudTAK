/**
 * Terrain Data Downloader - CloudTAK API routes
 *
 * Copied into CloudTAK's api/stateless/routes/ by TAK Portal (catalog "routes": {"source": "server"}).
 * CloudTAK loads every file in that directory as a router, so this file is intentionally
 * self-contained: no sibling helper modules and no dependencies beyond what the CloudTAK API ships.
 *
 * Pipeline (all server side so multi-GB downloads never pass through a browser):
 *   Terrain  : AWS Open Data "Terrain Tiles" (Terrarium PNG, USGS 3DEP / SRTM / GMTED / ETOPO)
 *              -> tiles covering the selected state polygons -> ONE raster PMTiles archive
 *   Snapping : BBBike per-state OSM "PMTiles Shortbread" extract (zip, fetched with HTTP Range)
 *              -> keep only LineStrings of the admin-selected categories (roads, trails, railways,
 *                 rivers, ...) from the relevant layers, merged into one layer `out` with a `category` field
 *              -> one PMTiles per state, or one merged archive
 *   Output   : written to the CloudTAK asset bucket under public/ - the same place as
 *              Admin -> Hosted Tilesets - so CloudTAK's PMTiles server, terrain and snapping
 *              features work on them exactly as on any hosted tileset.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { Type, type Static } from '@sinclair/typebox';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import jwt from 'jsonwebtoken';
import Auth from '../../common/auth.js';
import S3 from '../../common/aws/s3.js';
import { sql } from 'drizzle-orm';
import type ConfigStateless from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFIX = '/plugin/terrain-data-downloader';
const FILE_PREFIX = 'tdd-';
const USER_AGENT = 'CloudTAK-Terrain-Data-Downloader/1.0 (+https://github.com/dfpc-coe/CloudTAK)';

const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRAIN_ATTRIBUTION = 'Terrain Tiles (AWS Open Data, Mapzen): USGS 3DEP, NASA SRTM, GMTED2010, ETOPO1';
const BBBIKE_REGION = 'https://data.bbbike.org/osm/region/north-america/us';
const BBBIKE_PMTILES = 'https://data.bbbike.org/osm/pmtiles/region/north-america/us';
const SNAP_ATTRIBUTION = '© OpenStreetMap contributors (ODbL), extract by BBBike.org';

/** Terrarium tiles exist to z15; z13 (~15 m) is the useful ceiling for state-sized areas */
const TERRAIN_MIN_ZOOM = 0;
const TERRAIN_ZOOMS = [10, 11, 12, 13];
const TERRAIN_AVG_TILE_BYTES = 55_000;
const MAX_TERRAIN_TILES = 250_000;
const TERRAIN_CONCURRENCY = 24;

const SNAP_LAYER_OUT = 'out';
const RAIL_KINDS = new Set(['rail', 'narrow_gauge', 'tram', 'light_rail', 'funicular', 'subway', 'monorail', 'miniature', 'disused', 'preserved']);
const TRAIL_KINDS = new Set(['path', 'footway', 'cycleway', 'bridleway', 'steps', 'pedestrian']);
const AEROWAY_KINDS = new Set(['runway', 'taxiway']);
const RIVER_KINDS = new Set(['river', 'canal']);
const SETTINGS_KEY = 'plugins/terrain-data-downloader/settings.json';

interface SnapCategory {
    id: string;
    label: string;
    description: string;
    default: boolean;
    /** Shortbread source layer(s) */
    layers: string[];
    /** Feature belongs to this category (kind = Shortbread `kind`, rail = Shortbread `rail` flag) */
    match: (layer: string, kind: string | null, rail: boolean) => boolean;
}

/**
 * Snapping categories built from the LineString layers of the BBBike Shortbread extracts.
 * Label layers (street_labels, water_lines_labels) duplicate geometry and are never used.
 */
const SNAP_CATEGORIES: SnapCategory[] = [
    {
        id: 'roads', label: 'Roads', description: 'Motorways to residential streets, including ramps', default: true,
        layers: ['streets'],
        match: (_l, kind, rail) => !rail && kind !== 'service' && kind !== 'track'
            && !(kind && (TRAIL_KINDS.has(kind) || RAIL_KINDS.has(kind) || AEROWAY_KINDS.has(kind))),
    },
    {
        id: 'service', label: 'Service roads', description: 'Driveways, parking aisles, alleys', default: true,
        layers: ['streets'], match: (_l, kind, rail) => !rail && kind === 'service',
    },
    {
        id: 'tracks', label: 'Tracks', description: 'Forest, farm and 4x4 tracks', default: true,
        layers: ['streets'], match: (_l, kind, rail) => !rail && kind === 'track',
    },
    {
        id: 'trails', label: 'Trails & paths', description: 'Hiking paths, footways, cycleways, bridleways, steps', default: true,
        layers: ['streets'], match: (_l, kind, rail) => !rail && kind !== null && TRAIL_KINDS.has(kind),
    },
    {
        id: 'railways', label: 'Railways', description: 'Rail, light rail, tram, subway', default: false,
        layers: ['streets'], match: (_l, kind, rail) => rail || (kind !== null && RAIL_KINDS.has(kind)),
    },
    {
        id: 'rivers', label: 'Rivers & canals', description: 'River and canal centerlines', default: false,
        layers: ['water_lines'], match: (_l, kind) => kind !== null && RIVER_KINDS.has(kind),
    },
    {
        id: 'streams', label: 'Streams & ditches', description: 'Streams, ditches and drains', default: false,
        layers: ['water_lines'], match: (_l, kind) => kind === null || !RIVER_KINDS.has(kind),
    },
    {
        id: 'aeroways', label: 'Runways & taxiways', description: 'Airport runway and taxiway centerlines', default: false,
        layers: ['streets'], match: (_l, kind, rail) => !rail && kind !== null && AEROWAY_KINDS.has(kind),
    },
    {
        id: 'ferries', label: 'Ferry routes', description: 'Ferry lines', default: false,
        layers: ['ferries'], match: () => true,
    },
    {
        id: 'aerialways', label: 'Aerialways', description: 'Ski lifts, gondolas, cable cars', default: false,
        layers: ['aerialways'], match: () => true,
    },
    {
        id: 'piers', label: 'Piers, breakwaters & dams', description: 'Piers, groynes, breakwaters and dam lines', default: false,
        layers: ['pier_lines', 'dam_lines'], match: () => true,
    },
    {
        id: 'boundaries', label: 'State & national boundaries', description: 'Administrative boundary lines', default: false,
        layers: ['boundaries'], match: () => true,
    },
];
const SNAP_CATEGORY_IDS = new Set(SNAP_CATEGORIES.map((c) => c.id));
const SNAP_SOURCE_LAYERS = new Set(SNAP_CATEGORIES.flatMap((c) => c.layers));

const MAX_JOBS_KEPT = 25;
const MAX_LOG_LINES = 200;

interface StateDef {
    slug: string;
    abbr: string;
    name: string;
    area: number;
    /** Only for states BBBike publishes no boundary polygon for: [w, s, e, n] */
    bbox?: [number, number, number, number];
}

/** BBBike slugs + total area (km²) for estimates. 50 states, DC, PR and USVI. */
const STATES: StateDef[] = [
    { slug: 'alabama', abbr: 'AL', name: 'Alabama', area: 135767 },
    { slug: 'alaska', abbr: 'AK', name: 'Alaska', area: 1723337 },
    { slug: 'arizona', abbr: 'AZ', name: 'Arizona', area: 295234 },
    { slug: 'arkansas', abbr: 'AR', name: 'Arkansas', area: 137732 },
    { slug: 'california', abbr: 'CA', name: 'California', area: 423967 },
    { slug: 'colorado', abbr: 'CO', name: 'Colorado', area: 269601 },
    { slug: 'connecticut', abbr: 'CT', name: 'Connecticut', area: 14357 },
    { slug: 'delaware', abbr: 'DE', name: 'Delaware', area: 6446 },
    { slug: 'district-of-columbia', abbr: 'DC', name: 'District of Columbia', area: 177 },
    { slug: 'florida', abbr: 'FL', name: 'Florida', area: 170312 },
    { slug: 'georgia', abbr: 'GA', name: 'Georgia', area: 153910, bbox: [-85.61, 30.35, -80.75, 35.01] },
    { slug: 'hawaii', abbr: 'HI', name: 'Hawaii', area: 28313 },
    { slug: 'idaho', abbr: 'ID', name: 'Idaho', area: 216443 },
    { slug: 'illinois', abbr: 'IL', name: 'Illinois', area: 149995 },
    { slug: 'indiana', abbr: 'IN', name: 'Indiana', area: 94326 },
    { slug: 'iowa', abbr: 'IA', name: 'Iowa', area: 145746 },
    { slug: 'kansas', abbr: 'KS', name: 'Kansas', area: 213100 },
    { slug: 'kentucky', abbr: 'KY', name: 'Kentucky', area: 104656 },
    { slug: 'louisiana', abbr: 'LA', name: 'Louisiana', area: 135659 },
    { slug: 'maine', abbr: 'ME', name: 'Maine', area: 91633 },
    { slug: 'maryland', abbr: 'MD', name: 'Maryland', area: 32131 },
    { slug: 'massachusetts', abbr: 'MA', name: 'Massachusetts', area: 27336 },
    { slug: 'michigan', abbr: 'MI', name: 'Michigan', area: 250487 },
    { slug: 'minnesota', abbr: 'MN', name: 'Minnesota', area: 225163 },
    { slug: 'mississippi', abbr: 'MS', name: 'Mississippi', area: 125438 },
    { slug: 'missouri', abbr: 'MO', name: 'Missouri', area: 180540 },
    { slug: 'montana', abbr: 'MT', name: 'Montana', area: 380831 },
    { slug: 'nebraska', abbr: 'NE', name: 'Nebraska', area: 200330 },
    { slug: 'nevada', abbr: 'NV', name: 'Nevada', area: 286380 },
    { slug: 'new-hampshire', abbr: 'NH', name: 'New Hampshire', area: 24214 },
    { slug: 'new-jersey', abbr: 'NJ', name: 'New Jersey', area: 22591 },
    { slug: 'new-mexico', abbr: 'NM', name: 'New Mexico', area: 314917 },
    { slug: 'new-york', abbr: 'NY', name: 'New York', area: 141297 },
    { slug: 'north-carolina', abbr: 'NC', name: 'North Carolina', area: 139391 },
    { slug: 'north-dakota', abbr: 'ND', name: 'North Dakota', area: 183108 },
    { slug: 'ohio', abbr: 'OH', name: 'Ohio', area: 116098 },
    { slug: 'oklahoma', abbr: 'OK', name: 'Oklahoma', area: 181037 },
    { slug: 'oregon', abbr: 'OR', name: 'Oregon', area: 254799 },
    { slug: 'pennsylvania', abbr: 'PA', name: 'Pennsylvania', area: 119280 },
    { slug: 'puerto-rico', abbr: 'PR', name: 'Puerto Rico', area: 13791 },
    { slug: 'rhode-island', abbr: 'RI', name: 'Rhode Island', area: 4001 },
    { slug: 'south-carolina', abbr: 'SC', name: 'South Carolina', area: 82933 },
    { slug: 'south-dakota', abbr: 'SD', name: 'South Dakota', area: 199729 },
    { slug: 'tennessee', abbr: 'TN', name: 'Tennessee', area: 109153 },
    { slug: 'texas', abbr: 'TX', name: 'Texas', area: 695662 },
    { slug: 'us-virgin-islands', abbr: 'VI', name: 'U.S. Virgin Islands', area: 1898 },
    { slug: 'utah', abbr: 'UT', name: 'Utah', area: 219882 },
    { slug: 'vermont', abbr: 'VT', name: 'Vermont', area: 24906 },
    { slug: 'virginia', abbr: 'VA', name: 'Virginia', area: 110787 },
    { slug: 'washington', abbr: 'WA', name: 'Washington', area: 184661 },
    { slug: 'west-virginia', abbr: 'WV', name: 'West Virginia', area: 62756 },
    { slug: 'wisconsin', abbr: 'WI', name: 'Wisconsin', area: 169635 },
    { slug: 'wyoming', abbr: 'WY', name: 'Wyoming', area: 253335 },
];
const STATE_BY_SLUG = new Map(STATES.map((s) => [s.slug, s]));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const JobRequest = Type.Object({
    add: Type.Array(Type.String(), { maxItems: STATES.length, description: 'States to add to the master layers, or re-download if already present' }),
    remove: Type.Array(Type.String(), { maxItems: STATES.length, description: 'States to remove from the master layers whose "enabled" is true' }),
    terrain: Type.Object({
        enabled: Type.Boolean({ description: 'Apply "add", "remove" and the detail level to the terrain master layer' }),
        maxzoom: Type.Integer({ minimum: 10, maximum: 13, default: 12 }),
    }),
    snapping: Type.Object({
        enabled: Type.Boolean({ description: 'Apply "add", "remove" and the categories to the snapping master layer' }),
        categories: Type.Array(Type.String(), { description: 'Snapping category ids, see GET /categories' }),
    }),
});
type JobRequestT = Static<typeof JobRequest>;

const MasterTerrain = Type.Object({
    basemap: Type.Union([Type.Null(), Type.Integer()]),
    file: Type.String(),
    states: Type.Array(Type.String()),
    maxzoom: Type.Integer(),
    bytes: Type.Integer(),
    updated: Type.String(),
});

const MasterSnap = Type.Object({
    basemap: Type.Union([Type.Null(), Type.Integer()]),
    file: Type.String(),
    states: Type.Array(Type.String()),
    categories: Type.Array(Type.String()),
    bytes: Type.Integer(),
    updated: Type.String(),
});

/** Persistent plugin state: the two master layers */
const Settings = Type.Object({
    terrain: Type.Union([Type.Null(), MasterTerrain]),
    snap: Type.Union([Type.Null(), MasterSnap]),
});
type SettingsT = Static<typeof Settings>;

const LegacyLayer = Type.Object({
    id: Type.Integer(),
    name: Type.String(),
    type: Type.String(),
    file: Type.String(),
    states: Type.Array(Type.String()),
});
type LegacyLayerT = Static<typeof LegacyLayer>;

const JobSchema = Type.Object({
    id: Type.String(),
    status: Type.String({ enum: ['queued', 'running', 'success', 'failed', 'cancelled'] }),
    username: Type.String(),
    created: Type.String(),
    updated: Type.String(),
    request: JobRequest,
    step: Type.String(),
    progress: Type.Number(),
    log: Type.Array(Type.String()),
    summary: Type.Array(Type.String()),
    error: Type.Optional(Type.String()),
});
type JobT = Static<typeof JobSchema>;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function fetchRetry(url: string, init: RequestInit = {}, opts: { retries?: number; timeout?: number; allow404?: boolean } = {}): Promise<Response> {
    const retries = opts.retries ?? 3;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                ...init,
                headers: { 'User-Agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
                signal: AbortSignal.timeout(opts.timeout ?? 60_000),
            });

            if (res.ok || (opts.allow404 && (res.status === 404 || res.status === 403))) return res;
            await res.body?.cancel().catch(() => undefined);
            lastErr = new Error(`${url} returned HTTP ${res.status}`);
            if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        } catch (err) {
            lastErr = err;
        }

        await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchRange(url: string, start: number, end: number): Promise<Buffer> {
    const res = await fetchRetry(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (res.status !== 206) throw new Error(`${url} does not support HTTP Range requests (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// PMTiles v3 - minimal reader/writer (spec: github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md)
// ---------------------------------------------------------------------------

const PM_COMPRESSION = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 } as const;
const PM_TILETYPE = { unknown: 0, mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5 } as const;
const PM_HEADER_LEN = 127;
const PM_ROOT_MAX = 16_384 - PM_HEADER_LEN;

interface PMEntry {
    tileId: number;
    offset: number;
    length: number;
    runLength: number;
}

interface PMHeader {
    rootOffset: number; rootLength: number;
    metadataOffset: number; metadataLength: number;
    leafOffset: number; leafLength: number;
    dataOffset: number; dataLength: number;
    addressedTiles: number; tileEntries: number; tileContents: number;
    clustered: boolean;
    internalCompression: number; tileCompression: number; tileType: number;
    minZoom: number; maxZoom: number;
    minLon: number; minLat: number; maxLon: number; maxLat: number;
    centerZoom: number; centerLon: number; centerLat: number;
}

/** Number of tiles in all zoom levels below z: (4^z - 1) / 3 */
function tzBase(z: number): number {
    return (Math.pow(4, z) - 1) / 3;
}

function zxyToTileId(z: number, x: number, y: number): number {
    // Port of pmtiles zxyToTileId (Hilbert curve within each zoom level)
    if (z === 0) return 0;
    let d = 0;
    let tx = x;
    let ty = y;
    for (let s = Math.pow(2, z) / 2; s >= 1; s /= 2) {
        const rx = (tx & s) > 0 ? 1 : 0;
        const ry = (ty & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        if (ry === 0) {
            if (rx === 1) {
                tx = s - 1 - tx;
                ty = s - 1 - ty;
            }
            const t = tx; tx = ty; ty = t;
        }
    }
    return tzBase(z) + d;
}

function tileIdZoom(id: number): number {
    let z = 0;
    while (tzBase(z + 1) <= id) z++;
    return z;
}

function writeVarint(out: number[], value: number): void {
    let n = value;
    while (n >= 128) {
        out.push((n % 128) | 128);
        n = Math.floor(n / 128);
    }
    out.push(n);
}

function serializeDirectory(entries: PMEntry[]): Buffer {
    const out: number[] = [];
    writeVarint(out, entries.length);
    let last = 0;
    for (const e of entries) { writeVarint(out, e.tileId - last); last = e.tileId; }
    for (const e of entries) writeVarint(out, e.runLength);
    for (const e of entries) writeVarint(out, e.length);
    for (let i = 0; i < entries.length; i++) {
        const prev = entries[i - 1];
        if (i > 0 && entries[i].offset === prev.offset + prev.length) writeVarint(out, 0);
        else writeVarint(out, entries[i].offset + 1);
    }
    return zlib.gzipSync(Buffer.from(out));
}

class VarintReader {
    buf: Buffer;
    pos = 0;
    constructor(buf: Buffer) { this.buf = buf; }
    next(): number {
        let result = 0;
        let mult = 1;
        for (;;) {
            if (this.pos >= this.buf.length) throw new Error('Truncated varint');
            const b = this.buf[this.pos++];
            result += (b & 0x7f) * mult;
            if (b < 128) return result;
            mult *= 128;
        }
    }
}

function deserializeDirectory(buf: Buffer): PMEntry[] {
    const r = new VarintReader(buf);
    const n = r.next();
    const entries: PMEntry[] = [];
    let last = 0;
    for (let i = 0; i < n; i++) { last += r.next(); entries.push({ tileId: last, offset: 0, length: 0, runLength: 1 }); }
    for (let i = 0; i < n; i++) entries[i].runLength = r.next();
    for (let i = 0; i < n; i++) entries[i].length = r.next();
    for (let i = 0; i < n; i++) {
        const v = r.next();
        entries[i].offset = (v === 0 && i > 0) ? entries[i - 1].offset + entries[i - 1].length : v - 1;
    }
    return entries;
}

function decompress(buf: Buffer, compression: number): Buffer {
    if (compression === PM_COMPRESSION.none) return buf;
    if (compression === PM_COMPRESSION.gzip) return zlib.gunzipSync(buf);
    if (compression === PM_COMPRESSION.brotli) return zlib.brotliDecompressSync(buf);
    if (compression === PM_COMPRESSION.zstd) {
        const z = zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer };
        if (z.zstdDecompressSync) return z.zstdDecompressSync(buf);
    }
    throw new Error(`Unsupported PMTiles compression: ${compression}`);
}

function encodeHeader(h: PMHeader): Buffer {
    const b = Buffer.alloc(PM_HEADER_LEN);
    b.write('PMTiles', 0, 'latin1');
    b[7] = 3;
    const u64 = [h.rootOffset, h.rootLength, h.metadataOffset, h.metadataLength, h.leafOffset, h.leafLength,
        h.dataOffset, h.dataLength, h.addressedTiles, h.tileEntries, h.tileContents];
    u64.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 8 + i * 8));
    b[96] = h.clustered ? 1 : 0;
    b[97] = h.internalCompression;
    b[98] = h.tileCompression;
    b[99] = h.tileType;
    b[100] = h.minZoom;
    b[101] = h.maxZoom;
    b.writeInt32LE(Math.round(h.minLon * 1e7), 102);
    b.writeInt32LE(Math.round(h.minLat * 1e7), 106);
    b.writeInt32LE(Math.round(h.maxLon * 1e7), 110);
    b.writeInt32LE(Math.round(h.maxLat * 1e7), 114);
    b[118] = h.centerZoom;
    b.writeInt32LE(Math.round(h.centerLon * 1e7), 119);
    b.writeInt32LE(Math.round(h.centerLat * 1e7), 123);
    return b;
}

function decodeHeader(b: Buffer): PMHeader {
    if (b.length < PM_HEADER_LEN || b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) {
        throw new Error('Not a PMTiles v3 archive');
    }
    const u = (i: number): number => Number(b.readBigUInt64LE(8 + i * 8));
    return {
        rootOffset: u(0), rootLength: u(1), metadataOffset: u(2), metadataLength: u(3),
        leafOffset: u(4), leafLength: u(5), dataOffset: u(6), dataLength: u(7),
        addressedTiles: u(8), tileEntries: u(9), tileContents: u(10),
        clustered: b[96] === 1, internalCompression: b[97], tileCompression: b[98], tileType: b[99],
        minZoom: b[100], maxZoom: b[101],
        minLon: b.readInt32LE(102) / 1e7, minLat: b.readInt32LE(106) / 1e7,
        maxLon: b.readInt32LE(110) / 1e7, maxLat: b.readInt32LE(114) / 1e7,
        centerZoom: b[118], centerLon: b.readInt32LE(119) / 1e7, centerLat: b.readInt32LE(123) / 1e7,
    };
}

async function readAt(fh: fsp.FileHandle, offset: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new Error('Unexpected end of PMTiles archive');
    return buf;
}

/** Walk every tile entry (runLength > 0) of a local PMTiles archive in tile-id order */
async function* pmtilesEntries(fh: fsp.FileHandle, h: PMHeader): AsyncGenerator<PMEntry> {
    async function* walk(offset: number, length: number, depth: number): AsyncGenerator<PMEntry> {
        if (depth > 4) throw new Error('PMTiles directory nesting too deep');
        const dir = deserializeDirectory(decompress(await readAt(fh, offset, length), h.internalCompression));
        for (const e of dir) {
            if (e.runLength > 0) yield e;
            else yield* walk(h.leafOffset + e.offset, e.length, depth + 1);
        }
    }
    yield* walk(h.rootOffset, h.rootLength, 0);
}

interface TileStore {
    /** Temp file holding raw (uncompressed for MVT) tile bodies */
    file: string;
    entries: PMEntry[];
}

/**
 * Assemble a PMTiles archive from a store of already-final tile bodies.
 * Layout: header | root dir | metadata | leaf dirs | tile data
 */
async function writePMTiles(
    store: TileStore,
    outFile: string,
    opts: {
        tileType: number;
        tileCompression: number;
        metadata: Record<string, unknown>;
        bounds: [number, number, number, number];
    },
): Promise<{ bytes: number; minZoom: number; maxZoom: number }> {
    const entries = store.entries.slice().sort((a, b) => a.tileId - b.tileId);
    if (!entries.length) throw new Error('No tiles were produced');

    let root = serializeDirectory(entries);
    let leaves = Buffer.alloc(0);
    if (root.length > PM_ROOT_MAX) {
        for (let leafSize = 4096; ; leafSize *= 2) {
            const rootEntries: PMEntry[] = [];
            const parts: Buffer[] = [];
            let offset = 0;
            for (let i = 0; i < entries.length; i += leafSize) {
                const leaf = serializeDirectory(entries.slice(i, i + leafSize));
                rootEntries.push({ tileId: entries[i].tileId, offset, length: leaf.length, runLength: 0 });
                parts.push(leaf);
                offset += leaf.length;
            }
            root = serializeDirectory(rootEntries);
            if (root.length <= PM_ROOT_MAX) { leaves = Buffer.concat(parts); break; }
        }
    }

    const metadata = zlib.gzipSync(Buffer.from(JSON.stringify(opts.metadata)));
    const dataLength = (await fsp.stat(store.file)).size;
    const contents = new Set(entries.map((e) => e.offset)).size;
    const minZoom = tileIdZoom(entries[0].tileId);
    const maxZoom = tileIdZoom(entries[entries.length - 1].tileId);
    const [w, s, e, n] = opts.bounds;

    const header = encodeHeader({
        rootOffset: PM_HEADER_LEN, rootLength: root.length,
        metadataOffset: PM_HEADER_LEN + root.length, metadataLength: metadata.length,
        leafOffset: PM_HEADER_LEN + root.length + metadata.length, leafLength: leaves.length,
        dataOffset: PM_HEADER_LEN + root.length + metadata.length + leaves.length, dataLength,
        addressedTiles: entries.reduce((acc, en) => acc + en.runLength, 0),
        tileEntries: entries.length,
        tileContents: contents,
        clustered: false,
        internalCompression: PM_COMPRESSION.gzip,
        tileCompression: opts.tileCompression,
        tileType: opts.tileType,
        minZoom, maxZoom,
        minLon: w, minLat: s, maxLon: e, maxLat: n,
        centerZoom: Math.round((minZoom + maxZoom) / 2),
        centerLon: (w + e) / 2, centerLat: (s + n) / 2,
    });

    const out = fs.createWriteStream(outFile);
    await pipeline(Readable.from((async function* () {
        yield header; yield root; yield metadata; yield leaves;
        for await (const chunk of fs.createReadStream(store.file)) yield chunk as Buffer;
    })()), out);

    return { bytes: (await fsp.stat(outFile)).size, minZoom, maxZoom };
}

/** Append-only tile body store with content de-duplication */
class TileWriter {
    file: string;
    fh: fsp.FileHandle;
    entries: PMEntry[] = [];
    offset = 0;
    seen = new Map<string, { offset: number; length: number }>();

    private constructor(file: string, fh: fsp.FileHandle) { this.file = file; this.fh = fh; }

    static async open(file: string): Promise<TileWriter> {
        return new TileWriter(file, await fsp.open(file, 'w'));
    }

    /** Reserve the offset synchronously so concurrent callers never overlap */
    async add(tileId: number, body: Buffer): Promise<void> {
        const hash = crypto.createHash('sha1').update(body).digest('hex');
        const dup = this.seen.get(hash);
        if (dup) {
            this.entries.push({ tileId, offset: dup.offset, length: dup.length, runLength: 1 });
            return;
        }
        const offset = this.offset;
        this.offset += body.length;
        this.seen.set(hash, { offset, length: body.length });
        this.entries.push({ tileId, offset, length: body.length, runLength: 1 });
        await this.fh.write(body, 0, body.length, offset);
    }

    async close(): Promise<TileStore> {
        await this.fh.close();
        this.seen.clear();
        return { file: this.file, entries: this.entries };
    }
}

// ---------------------------------------------------------------------------
// Mapbox Vector Tile - just enough protobuf to filter and merge one layer
// ---------------------------------------------------------------------------

class PbfReader {
    buf: Buffer;
    pos: number;
    end: number;
    constructor(buf: Buffer, start = 0, end = buf.length) { this.buf = buf; this.pos = start; this.end = end; }
    get done(): boolean { return this.pos >= this.end; }
    varint(): number {
        let result = 0;
        let mult = 1;
        for (;;) {
            if (this.pos >= this.end) throw new Error('Truncated protobuf varint');
            const b = this.buf[this.pos++];
            result += (b & 0x7f) * mult;
            if (b < 128) return result;
            mult *= 128;
        }
    }
    /** Returns [field, wireType, start, end] for the next field and skips past it */
    field(): { field: number; wire: number; start: number; end: number; value: number } {
        const tag = this.varint();
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        const fieldStart = this.pos;
        let value = 0;
        if (wire === 0) { value = this.varint(); }
        else if (wire === 1) { this.pos += 8; }
        else if (wire === 5) { this.pos += 4; }
        else if (wire === 2) {
            const len = this.varint();
            const start = this.pos;
            this.pos += len;
            if (this.pos > this.end) throw new Error('Truncated protobuf message');
            return { field, wire, start, end: this.pos, value: len };
        } else { throw new Error(`Unsupported protobuf wire type ${wire}`); }
        return { field, wire, start: fieldStart, end: this.pos, value };
    }
}

class PbfWriter {
    parts: Buffer[] = [];
    private varintBuf(n: number): Buffer { const o: number[] = []; writeVarint(o, n); return Buffer.from(o); }
    varintField(field: number, value: number): void { this.parts.push(this.varintBuf(field * 8), this.varintBuf(value)); }
    bytesField(field: number, bytes: Buffer): void { this.parts.push(this.varintBuf(field * 8 + 2), this.varintBuf(bytes.length), bytes); }
    packedField(field: number, values: number[]): void {
        const o: number[] = [];
        for (const v of values) writeVarint(o, v);
        this.bytesField(field, Buffer.from(o));
    }
    finish(): Buffer { return Buffer.concat(this.parts); }
}

interface MvtFeature { id?: number; tags: number[]; type: number; geometry: Buffer }
interface MvtLayer { name: string; extent: number; keys: string[]; values: Buffer[]; features: MvtFeature[] }

function decodeValueString(raw: Buffer): string | boolean | null {
    const r = new PbfReader(raw);
    while (!r.done) {
        const f = r.field();
        if (f.field === 1 && f.wire === 2) return raw.toString('utf8', f.start, f.end);
        if (f.field === 7 && f.wire === 0) return f.value !== 0;
    }
    return null;
}

function decodeLayer(buf: Buffer, start: number, end: number, onlyName?: string): MvtLayer | null {
    const r = new PbfReader(buf, start, end);
    const layer: MvtLayer = { name: '', extent: 4096, keys: [], values: [], features: [] };
    const featureSpans: Array<[number, number]> = [];
    while (!r.done) {
        const f = r.field();
        if (f.field === 1 && f.wire === 2) {
            layer.name = buf.toString('utf8', f.start, f.end);
            if (onlyName && layer.name !== onlyName) return null;
        } else if (f.field === 2 && f.wire === 2) featureSpans.push([f.start, f.end]);
        else if (f.field === 3 && f.wire === 2) layer.keys.push(buf.toString('utf8', f.start, f.end));
        else if (f.field === 4 && f.wire === 2) layer.values.push(buf.subarray(f.start, f.end));
        else if (f.field === 5 && f.wire === 0) layer.extent = f.value;
    }
    if (onlyName && layer.name !== onlyName) return null;

    for (const [fs0, fe] of featureSpans) {
        const fr = new PbfReader(buf, fs0, fe);
        const feat: MvtFeature = { tags: [], type: 0, geometry: Buffer.alloc(0) };
        while (!fr.done) {
            const f = fr.field();
            if (f.field === 1 && f.wire === 0) feat.id = f.value;
            else if (f.field === 2 && f.wire === 2) {
                const tr = new PbfReader(buf, f.start, f.end);
                while (!tr.done) feat.tags.push(tr.varint());
            } else if (f.field === 3 && f.wire === 0) feat.type = f.value;
            else if (f.field === 4 && f.wire === 2) feat.geometry = buf.subarray(f.start, f.end);
        }
        layer.features.push(feat);
    }
    return layer;
}

function encodeLayer(layer: MvtLayer): Buffer {
    const lw = new PbfWriter();
    lw.varintField(15, 2);
    lw.bytesField(1, Buffer.from(layer.name, 'utf8'));
    for (const feat of layer.features) {
        const fw = new PbfWriter();
        if (feat.id !== undefined) fw.varintField(1, feat.id);
        if (feat.tags.length) fw.packedField(2, feat.tags);
        fw.varintField(3, feat.type);
        fw.bytesField(4, feat.geometry);
        lw.bytesField(2, fw.finish());
    }
    for (const k of layer.keys) lw.bytesField(3, Buffer.from(k, 'utf8'));
    for (const v of layer.values) lw.bytesField(4, v);
    lw.varintField(5, layer.extent);
    const tile = new PbfWriter();
    tile.bytesField(3, lw.finish());
    return tile.finish();
}

function encodeStringValue(s: string): Buffer {
    const w = new PbfWriter();
    w.bytesField(1, Buffer.from(s, 'utf8'));
    return w.finish();
}

/** Builds one output layer from features of several source layers, remapping key/value tables */
class LayerBuilder {
    layer: MvtLayer = { name: SNAP_LAYER_OUT, extent: 4096, keys: [], values: [], features: [] };
    private keyIdx = new Map<string, number>();
    private valIdx = new Map<string, number>();
    private seenGeom = new Set<string>();

    private key(k: string): number {
        let i = this.keyIdx.get(k);
        if (i === undefined) { i = this.layer.keys.push(k) - 1; this.keyIdx.set(k, i); }
        return i;
    }

    private value(v: Buffer): number {
        const vk = v.toString('base64');
        let i = this.valIdx.get(vk);
        if (i === undefined) { i = this.layer.values.push(v) - 1; this.valIdx.set(vk, i); }
        return i;
    }

    /** Adds a feature from `src`; duplicates (same geometry + category, e.g. border tiles) are dropped */
    add(src: MvtLayer, feat: MvtFeature, category?: string): void {
        const gkey = crypto.createHash('sha1').update(feat.geometry).update(category ?? '').digest('base64');
        if (this.seenGeom.has(gkey)) return;
        this.seenGeom.add(gkey);
        this.layer.extent = src.extent;

        const tags: number[] = [];
        for (let i = 0; i + 1 < feat.tags.length; i += 2) {
            const k = src.keys[feat.tags[i]];
            const v = src.values[feat.tags[i + 1]];
            if (k === undefined || v === undefined || (category && k === 'category')) continue;
            tags.push(this.key(k), this.value(v));
        }
        if (category) tags.push(this.key('category'), this.value(encodeStringValue(category)));
        this.layer.features.push({ id: feat.id, tags, type: feat.type, geometry: feat.geometry });
    }

    finish(): Buffer | null {
        return this.layer.features.length ? encodeLayer(this.layer) : null;
    }
}

/**
 * Keep only LineStrings belonging to the selected snapping categories, from every relevant
 * Shortbread layer, re-emitted as a single layer `out` with an added `category` attribute.
 * CloudTAK's snapper requests ?type=LineString without a layer filter, so anything left in the
 * tile becomes snappable - hence everything not selected is dropped here.
 */
function filterSnapTile(mvt: Buffer, categories: Set<string>): Buffer | null {
    const active = SNAP_CATEGORIES.filter((c) => categories.has(c.id));
    if (!active.length) return null;
    const builder = new LayerBuilder();

    const r = new PbfReader(mvt);
    while (!r.done) {
        const f = r.field();
        if (f.field !== 3 || f.wire !== 2) continue;
        const layer = decodeLayer(mvt, f.start, f.end);
        if (!layer || !SNAP_SOURCE_LAYERS.has(layer.name)) continue;
        const candidates = active.filter((c) => c.layers.includes(layer.name));
        if (!candidates.length) continue;

        const kindKey = layer.keys.indexOf('kind');
        const railKey = layer.keys.indexOf('rail');
        const valueCache = new Map<number, string | boolean | null>();
        const value = (i: number): string | boolean | null => {
            if (!valueCache.has(i)) valueCache.set(i, layer.values[i] ? decodeValueString(layer.values[i]) : null);
            return valueCache.get(i) ?? null;
        };

        for (const feat of layer.features) {
            if (feat.type !== 2) continue; // LINESTRING only - snapping requests type=LineString
            let kind: string | null = null;
            let rail = false;
            for (let i = 0; i + 1 < feat.tags.length; i += 2) {
                if (feat.tags[i] === kindKey) { const v = value(feat.tags[i + 1]); kind = typeof v === 'string' ? v : null; }
                if (feat.tags[i] === railKey && value(feat.tags[i + 1]) === true) rail = true;
            }
            const cat = candidates.find((c) => c.match(layer.name, kind, rail));
            if (cat) builder.add(layer, feat, cat.id);
        }
    }
    return builder.finish();
}

/**
 * Merge single-layer `out` tiles (adjacent states share border tiles), optionally keeping only
 * features whose `category` is in `categories`. Returns null when nothing is left.
 */
function mergeOutTiles(tiles: Buffer[], categories?: Set<string>): Buffer | null {
    const builder = new LayerBuilder();
    for (const tile of tiles) {
        const r = new PbfReader(tile);
        while (!r.done) {
            const f = r.field();
            if (f.field !== 3 || f.wire !== 2) continue;
            const layer = decodeLayer(tile, f.start, f.end, SNAP_LAYER_OUT);
            if (!layer) continue;
            const catKey = layer.keys.indexOf('category');
            for (const feat of layer.features) {
                let category: string | undefined;
                for (let i = 0; i + 1 < feat.tags.length; i += 2) {
                    if (feat.tags[i] === catKey) {
                        const v = layer.values[feat.tags[i + 1]];
                        const s = v ? decodeValueString(v) : null;
                        if (typeof s === 'string') category = s;
                    }
                }
                if (categories && (!category || !categories.has(category))) continue;
                builder.add(layer, feat, category);
            }
        }
    }
    return builder.finish();
}

// ---------------------------------------------------------------------------
// Geometry - state boundaries and tile cover
// ---------------------------------------------------------------------------

type Ring = Array<[number, number]>; // [lng, lat]
type Polygon = Ring[];
const boundaryCache = new Map<string, Polygon[]>();

async function stateBoundary(state: StateDef): Promise<Polygon[]> {
    const cached = boundaryCache.get(state.slug);
    if (cached) return cached;

    let polys: Polygon[];
    if (state.bbox) {
        const [w, s, e, n] = state.bbox;
        polys = [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];
    } else {
        const res = await fetchRetry(`${BBBIKE_REGION}/${state.slug}/${state.slug}.json`, {}, { timeout: 30_000 });
        // BBBike publishes MultiPolygon coordinates as [lat, lng]
        const raw = await res.json() as number[][][][];
        polys = raw.map((poly) => poly.map((ring) => ring.map((pt) => [Number(pt[1]), Number(pt[0])] as [number, number])));
        for (const poly of polys) for (const ring of poly) for (const [lng, lat] of ring) {
            if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) {
                throw new Error(`Invalid boundary polygon for ${state.name}`);
            }
        }
    }

    boundaryCache.set(state.slug, polys);
    return polys;
}

function boundsOf(polys: Polygon[]): [number, number, number, number] {
    let w = 180; let s = 90; let e = -180; let n = -90;
    for (const poly of polys) for (const ring of poly) for (const [lng, lat] of ring) {
        w = Math.min(w, lng); e = Math.max(e, lng); s = Math.min(s, lat); n = Math.max(n, lat);
    }
    return [w, s, e, n];
}

function lngToTileX(lng: number, z: number): number { return (lng + 180) / 360 * Math.pow(2, z); }
function latToTileY(lat: number, z: number): number {
    const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
    const r = clamped * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}

/**
 * Tiles touching a polygon at zoom z: every interior tile (scanline at tile centres) plus
 * every tile an edge passes through, with a one-tile buffer so generalised boundaries never clip terrain.
 */
function coverPolygon(poly: Polygon, z: number, out: Set<number>): void {
    const max = Math.pow(2, z) - 1;
    const rings = poly.map((ring) => ring.map(([lng, lat]) => [lngToTileX(lng, z), latToTileY(lat, z)] as [number, number]));
    const add = (x: number, y: number): void => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const tx = Math.floor(x) + dx; const ty = Math.floor(y) + dy;
            if (tx >= 0 && ty >= 0 && tx <= max && ty <= max) out.add(zxyToTileId(z, tx, ty));
        }
    };

    let minY = Infinity; let maxY = -Infinity;
    for (const ring of rings) {
        for (let i = 0; i + 1 < ring.length; i++) {
            const [ax, ay] = ring[i]; const [bx, by] = ring[i + 1];
            minY = Math.min(minY, ay, by); maxY = Math.max(maxY, ay, by);
            const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 4) + 1;
            for (let k = 0; k <= steps; k++) add(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps);
        }
    }

    for (let row = Math.max(0, Math.floor(minY)); row <= Math.min(max, Math.floor(maxY)); row++) {
        const yc = row + 0.5;
        const xs: number[] = [];
        for (const ring of rings) {
            for (let i = 0; i + 1 < ring.length; i++) {
                const [ax, ay] = ring[i]; const [bx, by] = ring[i + 1];
                if ((ay <= yc) !== (by <= yc)) xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
            }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            for (let col = Math.max(0, Math.ceil(xs[i] - 0.5)); col <= Math.min(max, Math.floor(xs[i + 1] - 0.5)); col++) {
                out.add(zxyToTileId(z, col, row));
            }
        }
    }
}

interface TerrainPlan { tiles: Array<{ id: number; z: number; x: number; y: number }>; bounds: [number, number, number, number] }

async function planTerrain(states: StateDef[], maxzoom: number): Promise<TerrainPlan> {
    const polys: Polygon[] = [];
    for (const s of states) polys.push(...await stateBoundary(s));

    const tiles: TerrainPlan['tiles'] = [];
    for (let z = TERRAIN_MIN_ZOOM; z <= maxzoom; z++) {
        const ids = new Set<number>();
        for (const poly of polys) coverPolygon(poly, z, ids);
        // Recover x/y by re-walking the cover - cheaper to keep a parallel map than invert the Hilbert curve
        const n = Math.pow(2, z);
        const lookup = new Map<number, [number, number]>();
        for (const poly of polys) {
            const [w, s, e, nn] = boundsOf([poly]);
            const x0 = Math.max(0, Math.floor(lngToTileX(w, z)) - 1); const x1 = Math.min(n - 1, Math.floor(lngToTileX(e, z)) + 1);
            const y0 = Math.max(0, Math.floor(latToTileY(nn, z)) - 1); const y1 = Math.min(n - 1, Math.floor(latToTileY(s, z)) + 1);
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                const id = zxyToTileId(z, x, y);
                if (ids.has(id) && !lookup.has(id)) lookup.set(id, [x, y]);
            }
        }
        for (const [id, [x, y]] of lookup) tiles.push({ id, z, x, y });
        await yieldLoop();
    }
    tiles.sort((a, b) => a.id - b.id);
    return { tiles, bounds: boundsOf(polys) };
}

// ---------------------------------------------------------------------------
// BBBike zip (single remote entry, read with HTTP Range - no full-archive buffering)
// ---------------------------------------------------------------------------

async function remoteSize(url: string): Promise<number> {
    const res = await fetchRetry(url, { method: 'HEAD' }, { timeout: 30_000 });
    const len = Number(res.headers.get('content-length'));
    if (!Number.isFinite(len) || len <= 0) throw new Error(`Could not determine size of ${url}`);
    return len;
}

async function downloadZipEntry(url: string, suffix: string, dest: string, onProgress: (done: number, total: number) => void, cancelled: () => boolean): Promise<void> {
    const size = await remoteSize(url);
    const tailStart = Math.max(0, size - 65_557);
    const tail = await fetchRange(url, tailStart, size - 1);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Downloaded file is not a zip archive');

    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
        // ZIP64: locator sits immediately before the EOCD
        const loc = eocd - 20;
        if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('Unsupported ZIP64 archive');
        const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
        const z64 = await fetchRange(url, z64Offset, z64Offset + 55);
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
    }

    const cd = await fetchRange(url, cdOffset, cdOffset + cdSize - 1);
    let entry: { method: number; compSize: number; localOffset: number } | null = null;
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
        const method = cd.readUInt16LE(p + 10);
        let compSize = cd.readUInt32LE(p + 20);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        let localOffset = cd.readUInt32LE(p + 42);
        const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

        if (name.endsWith(suffix)) {
            // ZIP64 extra field (0x0001) carries 64-bit sizes/offsets
            let e = p + 46 + nameLen;
            const eEnd = e + extraLen;
            while (e + 4 <= eEnd) {
                const id = cd.readUInt16LE(e); const len = cd.readUInt16LE(e + 2);
                if (id === 0x0001) {
                    let q = e + 4;
                    if (cd.readUInt32LE(p + 24) === 0xffffffff) q += 8;
                    if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
                    if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); }
                }
                e += 4 + len;
            }
            entry = { method, compSize, localOffset };
            break;
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    if (!entry) throw new Error(`No ${suffix} file inside ${url}`);
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported zip compression method ${entry.method}`);

    const local = await fetchRange(url, entry.localOffset, entry.localOffset + 29);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt zip local header');
    const dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

    const res = await fetchRetry(url, { headers: { Range: `bytes=${dataStart}-${dataStart + entry.compSize - 1}` } }, { timeout: 4 * 60 * 60 * 1000, retries: 1 });
    if (res.status !== 206 || !res.body) throw new Error('Range download failed');

    let done = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => {
        done += chunk.length;
        onProgress(done, entry.compSize);
        if (cancelled()) body.destroy(new Error('Cancelled'));
    });

    if (entry.method === 8) await pipeline(body, zlib.createInflateRaw(), fs.createWriteStream(dest));
    else await pipeline(body, fs.createWriteStream(dest));
}

// ---------------------------------------------------------------------------
// Persistent plugin state (asset bucket, outside public/ so it is never served as a tileset)
// ---------------------------------------------------------------------------

const SNAP_CACHE_PREFIX = 'plugins/terrain-data-downloader/cache';
const ALL_CATEGORIES = new Set(SNAP_CATEGORIES.map((c) => c.id));
const DEFAULT_CATEGORIES = SNAP_CATEGORIES.filter((c) => c.default).map((c) => c.id);

function snapCacheKey(slug: string): string {
    return `${SNAP_CACHE_PREFIX}/snap-${slug}.pmtiles`;
}

let settingsCache: { at: number; value: SettingsT } | null = null;

function emptySettings(): SettingsT {
    return { terrain: null, snap: null };
}

async function readSettings(fresh = false): Promise<SettingsT> {
    if (!fresh && settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
    let value = emptySettings();
    try {
        if (await S3.exists(SETTINGS_KEY)) {
            const chunks: Buffer[] = [];
            for await (const chunk of await S3.get(SETTINGS_KEY)) chunks.push(Buffer.from(chunk as Buffer));
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<SettingsT>;
            value = {
                terrain: raw.terrain && typeof raw.terrain === 'object' ? raw.terrain : null,
                snap: raw.snap && typeof raw.snap === 'object' ? raw.snap : null,
            };
        }
    } catch (err) {
        console.error('plugin-terrain-data-downloader: could not read settings', err);
        if (fresh) throw new Error(`Could not read plugin state from the asset bucket: ${errMessage(err)}`, { cause: err });
    }
    settingsCache = { at: Date.now(), value };
    return value;
}

async function writeSettings(value: SettingsT): Promise<void> {
    await S3.put(SETTINGS_KEY, JSON.stringify(value));
    settingsCache = { at: Date.now(), value };
}

// ---------------------------------------------------------------------------
// CloudTAK API calls (as the admin who started the job, through CloudTAK's own validation)
// ---------------------------------------------------------------------------

let CFG: ConfigStateless | null = null;

function cfg(): ConfigStateless {
    if (!CFG) throw new Error('Terrain Data Downloader routes are not initialised');
    return CFG;
}

class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
}

async function cloudtak<T>(username: string, method: string, pathname: string, body?: unknown): Promise<T> {
    // Server-minted user tokens carry no session claim, the same way CloudTAK's import worker signs
    const token = jwt.sign({ access: 'admin', email: username }, cfg().SigningSecret, { expiresIn: '1h' });
    const bases = [`http://127.0.0.1:${process.env.PORT || '5001'}`, cfg().API_URL.replace(/\/+$/, '')];
    let lastErr: unknown;

    for (const base of bases) {
        let res: Response;
        try {
            res = await fetch(base + pathname, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(60_000),
            });
        } catch (err) {
            lastErr = err; // unreachable on this address - try the next one
            continue;
        }

        const text = await res.text();
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        if (!res.ok) {
            const msg = (json && typeof json === 'object' && 'message' in json) ? String((json as { message: unknown }).message) : text.slice(0, 200);
            throw new ApiError(`CloudTAK ${method} ${pathname} failed (${res.status}): ${msg}`, res.status);
        }
        return json as T;
    }

    throw new Error(`Could not reach the CloudTAK API: ${errMessage(lastErr)}`);
}

function tileUrl(file: string, ext: string): string {
    return `${cfg().PMTILES_URL.replace(/\/+$/, '')}/tiles/public/${file}/tiles/{z}/{x}/{y}.${ext}`;
}

/** PATCH the master basemap in place (keeps its id, so overlays and defaults follow), or create it */
async function upsertBasemap(job: JobT, existing: number | null, body: Record<string, unknown>): Promise<number> {
    if (existing !== null) {
        try {
            await cloudtak(job.username, 'PATCH', `/api/basemap/${existing}`, body);
            return existing;
        } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
            log(job, `Master basemap ${existing} no longer exists - creating a new one`);
        }
    }

    const created = await cloudtak<{ id: number }>(job.username, 'POST', '/api/basemap', {
        ...body,
        scope: 'server',
        protocol: 'zxy',
        sharing_enabled: true,
        hidden: false,
        overlay: true,
        tilesize: 256,
    });
    return created.id;
}

async function deleteBasemap(job: JobT, id: number): Promise<void> {
    try {
        await cloudtak(job.username, 'DELETE', `/api/basemap/${id}`);
    } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
    }
}

async function currentDefaultTerrain(): Promise<number | null> {
    try {
        const setting = await cfg().models.Setting.typed('map::terrain', null);
        const value: unknown = setting.value;
        return value === null || value === undefined || value === '' ? null : Number(value);
    } catch {
        return null;
    }
}

async function setDefaultTerrain(job: JobT, id: number | null): Promise<void> {
    await cloudtak(job.username, 'PUT', '/api/config', { 'map::terrain': id });
}

async function deleteHostedFile(job: JobT, file: string | null | undefined): Promise<void> {
    if (!file || !file.startsWith(FILE_PREFIX)) return;
    try {
        await S3.del(`public/${file}.pmtiles`);
    } catch (err) {
        log(job, `Could not delete old file ${file}: ${errMessage(err)}`);
    }
}

async function downloadFromBucket(key: string, dest: string): Promise<void> {
    await pipeline(await S3.get(key), fs.createWriteStream(dest));
}

// ---------------------------------------------------------------------------
// Layers created by plugin versions before the master-layer design (v1.0-1.2)
// ---------------------------------------------------------------------------

function fileFromUrl(url: string): string | null {
    const m = url.match(/\/tiles\/public\/(tdd-[A-Za-z0-9._-]+?)(?:\.pmtiles)?\/tiles\//);
    return m ? m[1] : null;
}

/** Old file names carry the state abbreviations: tdd-terrain-z12-co-ut-20261120-2135, tdd-snap-tn-..., tdd-roads-... */
function statesFromLegacyFile(file: string): string[] {
    const m = file.match(/^tdd-(?:terrain-z\d+|snap|roads)-(.+)-\d{8}-\d{4}$/);
    if (!m) return [];
    return m[1].split('-')
        .map((abbr) => STATES.find((st) => st.abbr.toLowerCase() === abbr)?.slug)
        .filter((slug): slug is string => !!slug);
}

async function findLegacy(s: SettingsT): Promise<LegacyLayerT[]> {
    const keep = new Set([s.terrain?.basemap, s.snap?.basemap].filter((id): id is number => typeof id === 'number'));
    const res = await cfg().models.Basemap.list({
        limit: 500,
        where: sql`url LIKE ${'%/tiles/public/' + FILE_PREFIX + '%'}`,
    });
    return res.items
        .filter((b) => !keep.has(b.id))
        .map((b) => {
            const file = fileFromUrl(b.url) ?? '';
            return { id: b.id, name: b.name, type: b.type, file, states: statesFromLegacyFile(file) };
        });
}

async function retireLegacy(job: JobT, layers: LegacyLayerT[]): Promise<void> {
    const defaultTerrain = await currentDefaultTerrain();
    for (const layer of layers) {
        try {
            if (defaultTerrain === layer.id) await setDefaultTerrain(job, null);
            await deleteBasemap(job, layer.id);
            await deleteHostedFile(job, layer.file);
            log(job, `Merged and removed old layer "${layer.name}"`);
        } catch (err) {
            log(job, `Could not remove old layer "${layer.name}": ${errMessage(err)}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobs = new Map<string, JobT>();
const cancelFlags = new Set<string>();
let queue: Promise<void> = Promise.resolve();
let runningJob: string | null = null;

function now(): string { return new Date().toISOString(); }

function log(job: JobT, msg: string): void {
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    job.updated = now();
}

function setStep(job: JobT, step: string, progress: number): void {
    job.step = step;
    job.progress = Math.max(0, Math.min(1, progress));
    job.updated = now();
}

function checkCancel(job: JobT): void {
    if (cancelFlags.has(job.id)) throw new Error('Cancelled');
}

function stamp(): string {
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, '0');
    const rand = crypto.randomBytes(2).toString('hex');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${rand}`;
}

function snapCategoryLabel(ids: string[]): string {
    const labels = SNAP_CATEGORIES.filter((c) => ids.includes(c.id)).map((c) => c.label);
    if (labels.length === SNAP_CATEGORIES.length) return 'all categories';
    return labels.length > 3 ? `${labels.length} categories` : labels.join(', ');
}

function stateLabel(states: StateDef[]): string {
    return states.length > 4 ? `${states.length} states` : states.map((s) => s.name).join(', ');
}

function defs(slugs: Iterable<string>): StateDef[] {
    const set = new Set(slugs);
    return STATES.filter((st) => set.has(st.slug)); // stable, alphabetical order
}

function sameSet(a: Iterable<string>, b: Iterable<string>): boolean {
    const x = new Set(a); const y = new Set(b);
    return x.size === y.size && [...x].every((v) => y.has(v));
}

/** Desired state of each master layer after applying a request to the current state */
interface Target {
    terrain: { touched: boolean; states: string[]; maxzoom: number; legacy: LegacyLayerT[] };
    snap: { touched: boolean; states: string[]; categories: string[]; legacy: LegacyLayerT[]; refresh: Set<string> };
}

function target(req: JobRequestT, s: SettingsT, legacy: LegacyLayerT[]): Target {
    const remove = new Set(req.remove);

    const tLegacy = legacy.filter((l) => l.type === 'raster-dem');
    const tBase = new Set([...(s.terrain?.states ?? []), ...tLegacy.flatMap((l) => l.states)]);
    const tNext = new Set(tBase);
    if (req.terrain.enabled) {
        for (const a of req.add) tNext.add(a);
        for (const r of remove) tNext.delete(r);
    }
    const tZoom = req.terrain.enabled ? req.terrain.maxzoom : (s.terrain?.maxzoom ?? req.terrain.maxzoom);
    const tTouched = tLegacy.length > 0 && req.terrain.enabled
        || !sameSet(tNext, s.terrain?.states ?? [])
        || (!!s.terrain && tZoom !== s.terrain.maxzoom);

    const sLegacy = legacy.filter((l) => l.type === 'vector');
    const sBase = new Set([...(s.snap?.states ?? []), ...sLegacy.flatMap((l) => l.states)]);
    const sNext = new Set(sBase);
    if (req.snapping.enabled) {
        for (const a of req.add) sNext.add(a);
        for (const r of remove) sNext.delete(r);
    }
    const sCats = req.snapping.enabled ? req.snapping.categories : (s.snap?.categories ?? DEFAULT_CATEGORIES);
    // Re-requesting a state that is already in the layer means "download its latest OSM data again"
    const refresh = new Set(req.snapping.enabled ? req.add.filter((a) => sBase.has(a)) : []);
    const sTouched = sLegacy.length > 0 && req.snapping.enabled
        || !sameSet(sNext, s.snap?.states ?? [])
        || (!!s.snap && !sameSet(sCats, s.snap.categories))
        || refresh.size > 0;

    return {
        terrain: { touched: tTouched, states: [...tNext], maxzoom: tZoom, legacy: tLegacy },
        snap: { touched: sTouched, states: [...sNext], categories: SNAP_CATEGORIES.filter((c) => sCats.includes(c.id)).map((c) => c.id), legacy: sLegacy, refresh },
    };
}

// ----- Terrain master ------------------------------------------------------

async function buildTerrain(job: JobT, s: SettingsT, t: Target['terrain'], tmp: string, span: [number, number]): Promise<void> {
    const old = s.terrain;
    const states = defs(t.states);

    if (!states.length) {
        setStep(job, 'Removing terrain layer', span[0]);
        if (old?.basemap) {
            if (await currentDefaultTerrain() === old.basemap) await setDefaultTerrain(job, null);
            await deleteBasemap(job, old.basemap);
        }
        await deleteHostedFile(job, old?.file);
        s.terrain = null;
        await writeSettings(s);
        await retireLegacy(job, t.legacy);
        job.summary.push('Terrain layer removed');
        log(job, 'Terrain: no states left - layer removed');
        return;
    }

    setStep(job, 'Planning terrain tiles', span[0]);
    const plan = await planTerrain(states, t.maxzoom);
    if (plan.tiles.length > MAX_TERRAIN_TILES) {
        throw new Error(`The terrain layer would be ${plan.tiles.length.toLocaleString()} tiles (limit ${MAX_TERRAIN_TILES.toLocaleString()}) for ${states.length} states - choose a lower detail level`);
    }
    log(job, `Terrain: ${states.length} state(s) at z${t.maxzoom}, ${plan.tiles.length.toLocaleString()} tiles`);

    // Reuse every tile the current master already holds - only new areas are fetched
    const reuse = new Map<number, { offset: number; length: number }>();
    let oldFh: fsp.FileHandle | null = null;
    let oldDataOffset = 0;
    if (old?.file) {
        const oldLocal = path.join(tmp, 'terrain-old.pmtiles');
        try {
            setStep(job, 'Reading current terrain layer', span[0]);
            await downloadFromBucket(`public/${old.file}.pmtiles`, oldLocal);
            oldFh = await fsp.open(oldLocal, 'r');
            const h = decodeHeader(await readAt(oldFh, 0, PM_HEADER_LEN));
            oldDataOffset = h.dataOffset;
            for await (const e of pmtilesEntries(oldFh, h)) {
                for (let i = 0; i < e.runLength; i++) reuse.set(e.tileId + i, { offset: e.offset, length: e.length });
            }
        } catch (err) {
            log(job, `Terrain: could not read the current layer (${errMessage(err)}) - fetching all tiles`);
            reuse.clear();
            if (oldFh) { await oldFh.close(); oldFh = null; }
        }
    }

    const writer = await TileWriter.open(path.join(tmp, 'terrain.data'));
    let next = 0;
    let done = 0;
    let reused = 0;
    let fetched = 0;
    let missing = 0;

    const worker = async (): Promise<void> => {
        while (next < plan.tiles.length) {
            checkCancel(job);
            const tile = plan.tiles[next++];
            const have = reuse.get(tile.id);
            if (have && oldFh) {
                await writer.add(tile.id, await readAt(oldFh, oldDataOffset + have.offset, have.length));
                reused++;
            } else {
                const res = await fetchRetry(`${TERRAIN_URL}/${tile.z}/${tile.x}/${tile.y}.png`, {}, { allow404: true, timeout: 30_000 });
                if (res.ok) { await writer.add(tile.id, Buffer.from(await res.arrayBuffer())); fetched++; }
                else { missing++; await res.body?.cancel().catch(() => undefined); }
            }
            done++;
            if (done % 200 === 0) setStep(job, `Terrain tiles ${done.toLocaleString()} / ${plan.tiles.length.toLocaleString()}`, span[0] + (span[1] - span[0]) * 0.85 * done / plan.tiles.length);
        }
    };
    try {
        await Promise.all(Array.from({ length: TERRAIN_CONCURRENCY }, () => worker()));
    } finally {
        await writer.close();
        if (oldFh) await oldFh.close();
    }
    log(job, `Terrain: reused ${reused.toLocaleString()} tiles, downloaded ${fetched.toLocaleString()}${missing ? `, ${missing} without source data` : ''}`);

    const file = `${FILE_PREFIX}terrain-${stamp()}`;
    const out = path.join(tmp, `${file}.pmtiles`);
    setStep(job, 'Writing terrain layer', span[0] + (span[1] - span[0]) * 0.88);
    const written = await writePMTiles({ file: writer.file, entries: writer.entries }, out, {
        tileType: PM_TILETYPE.png,
        tileCompression: PM_COMPRESSION.none,
        bounds: plan.bounds,
        metadata: {
            name: `Terrain ${stateLabel(states)}`,
            description: 'Terrarium-encoded elevation tiles (raster-dem) - Terrain Data Downloader master terrain layer',
            attribution: TERRAIN_ATTRIBUTION,
            type: 'baselayer',
            format: 'png',
            encoding: 'terrarium',
        },
    });
    await fsp.rm(writer.file, { force: true });
    setStep(job, 'Uploading terrain layer', span[0] + (span[1] - span[0]) * 0.92);
    await S3.put(`public/${file}.pmtiles`, fs.createReadStream(out));
    await fsp.rm(out, { force: true });

    setStep(job, 'Registering terrain layer in CloudTAK', span[0] + (span[1] - span[0]) * 0.97);
    const id = await upsertBasemap(job, old?.basemap ?? null, {
        name: `Terrain (z${t.maxzoom}) - ${stateLabel(states)}`.slice(0, 120),
        url: tileUrl(file, 'png'),
        type: 'raster-dem',
        encoding: 'terrarium',
        format: 'png',
        minzoom: written.minZoom,
        maxzoom: written.maxZoom,
        bounds: plan.bounds,
        attribution: TERRAIN_ATTRIBUTION,
        collection: null,
    });
    await setDefaultTerrain(job, id);

    s.terrain = { basemap: id, file, states: states.map((st) => st.slug), maxzoom: t.maxzoom, bytes: written.bytes, updated: now() };
    await writeSettings(s);
    if (old?.file && old.file !== file) await deleteHostedFile(job, old.file);
    await retireLegacy(job, t.legacy);

    job.summary.push(`Terrain updated: ${stateLabel(states)} (${(written.bytes / 1e6).toFixed(0)} MB)`);
    log(job, `Terrain: master layer ${id} updated (${(written.bytes / 1e6).toFixed(1)} MB)`);
}

// ----- Snapping master -----------------------------------------------------

/** Download one state's OSM extract and keep every snapping category (the per-state cache) */
async function buildSnapCache(job: JobT, state: StateDef, tmp: string, dest: string, span: [number, number]): Promise<number> {
    const url = `${BBBIKE_PMTILES}/${state.slug}/${state.slug}.osm.pmtiles-shortbread.zip`;
    const src = path.join(tmp, `${state.slug}-src.pmtiles`);
    const mid = span[0] + (span[1] - span[0]) * 0.5;

    log(job, `Snapping: downloading the latest OSM extract for ${state.name}`);
    await downloadZipEntry(url, '.pmtiles', src, (d, total) => {
        if (d % (8 * 1024 * 1024) < 65_536) setStep(job, `Downloading ${state.name} OSM extract ${(d / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`, span[0] + (mid - span[0]) * d / total);
    }, () => cancelFlags.has(job.id));

    const fh = await fsp.open(src, 'r');
    const writer = await TileWriter.open(path.join(tmp, `${state.slug}-cache.data`));
    try {
        const h = decodeHeader(await readAt(fh, 0, PM_HEADER_LEN));
        if (h.tileType !== PM_TILETYPE.mvt) throw new Error(`${state.name} extract is not a vector tileset`);
        let seen = 0;
        for await (const e of pmtilesEntries(fh, h)) {
            seen++;
            if (seen % 2000 === 0) {
                checkCancel(job);
                setStep(job, `Extracting snapping lines for ${state.name} (${(100 * seen / Math.max(1, h.tileEntries)).toFixed(0)}%)`, mid + (span[1] - mid) * seen / Math.max(1, h.tileEntries));
                await yieldLoop();
            }
            const mvt = decompress(await readAt(fh, h.dataOffset + e.offset, e.length), h.tileCompression);
            const filtered = filterSnapTile(mvt, ALL_CATEGORIES);
            if (!filtered) continue;
            const gz = zlib.gzipSync(filtered);
            for (let i = 0; i < e.runLength; i++) await writer.add(e.tileId + i, gz);
        }
    } finally {
        await fh.close();
        await fsp.rm(src, { force: true });
    }

    const store = await writer.close();
    if (!store.entries.length) {
        await fsp.rm(store.file, { force: true });
        return 0;
    }
    const bounds = boundsOf(await stateBoundary(state));
    await writePMTiles(store, dest, {
        tileType: PM_TILETYPE.mvt,
        tileCompression: PM_COMPRESSION.gzip,
        bounds,
        metadata: { name: `Snapping cache ${state.name}`, generator: 'cloudtak-plugin-terrain-data-downloader', categories: [...ALL_CATEGORIES] },
    });
    await fsp.rm(store.file, { force: true });
    await S3.put(snapCacheKey(state.slug), fs.createReadStream(dest));
    return store.entries.length;
}

async function buildSnap(job: JobT, s: SettingsT, t: Target['snap'], tmp: string, span: [number, number]): Promise<void> {
    const old = s.snap;
    const states = defs(t.states);
    const removed = (old?.states ?? []).filter((slug) => !t.states.includes(slug));

    // Only states that actually left the snapping layer lose their cache (a terrain-only removal keeps it)
    for (const slug of removed) {
        await S3.del(snapCacheKey(slug)).catch(() => undefined);
    }

    if (!states.length) {
        setStep(job, 'Removing snapping layer', span[0]);
        if (old?.basemap) await deleteBasemap(job, old.basemap);
        await deleteHostedFile(job, old?.file);
        s.snap = null;
        await writeSettings(s);
        await retireLegacy(job, t.legacy);
        job.summary.push('Snapping layer removed');
        log(job, 'Snapping: no states left - layer removed');
        return;
    }
    if (!t.categories.length) throw new Error('Select at least one snapping category');

    // 1. Make sure every state has a per-state cache (all categories); download new/refreshed states
    const caches: Array<{ state: StateDef; file: string }> = [];
    const per = (span[1] - span[0]) * 0.75 / states.length;
    for (let i = 0; i < states.length; i++) {
        checkCancel(job);
        const st = states[i];
        const file = path.join(tmp, `${st.slug}-cache.pmtiles`);
        const sub: [number, number] = [span[0] + per * i, span[0] + per * (i + 1)];
        const cached = !t.refresh.has(st.slug) && await S3.exists(snapCacheKey(st.slug)).catch(() => false);
        if (cached) {
            setStep(job, `Loading cached snapping data for ${st.name}`, sub[0]);
            try {
                await downloadFromBucket(snapCacheKey(st.slug), file);
                caches.push({ state: st, file });
                continue;
            } catch (err) {
                log(job, `Snapping: cache for ${st.name} unreadable (${errMessage(err)}) - downloading again`);
            }
        }
        const tiles = await buildSnapCache(job, st, tmp, file, sub);
        if (tiles) caches.push({ state: st, file });
        else log(job, `Snapping: no snapping lines found for ${st.name}`);
    }
    if (!caches.length) throw new Error('No snapping lines were found for the selected states');

    // 2. Merge every state's cache into one layer, keeping only the selected categories
    setStep(job, 'Merging snapping layer', span[0] + (span[1] - span[0]) * 0.78);
    const cats = new Set(t.categories);
    const opened: Array<{ fh: fsp.FileHandle; h: PMHeader }> = [];
    const byId = new Map<number, Array<{ src: number; offset: number; length: number }>>();
    const writer = await TileWriter.open(path.join(tmp, 'snap.data'));
    try {
        for (let i = 0; i < caches.length; i++) {
            const fh = await fsp.open(caches[i].file, 'r');
            const h = decodeHeader(await readAt(fh, 0, PM_HEADER_LEN));
            opened.push({ fh, h });
            for await (const e of pmtilesEntries(fh, h)) {
                for (let r = 0; r < e.runLength; r++) {
                    const list = byId.get(e.tileId + r);
                    const part = { src: i, offset: e.offset, length: e.length };
                    if (list) list.push(part); else byId.set(e.tileId + r, [part]);
                }
            }
        }

        let n = 0;
        for (const id of Array.from(byId.keys()).sort((a, b) => a - b)) {
            const bodies: Buffer[] = [];
            for (const part of byId.get(id) ?? []) {
                const o = opened[part.src];
                bodies.push(decompress(await readAt(o.fh, o.h.dataOffset + part.offset, part.length), o.h.tileCompression));
            }
            const mvt = mergeOutTiles(bodies, cats);
            if (mvt) await writer.add(id, zlib.gzipSync(mvt));
            if (++n % 5000 === 0) { checkCancel(job); await yieldLoop(); }
        }
    } finally {
        for (const o of opened) await o.fh.close();
    }
    const store = await writer.close();
    if (!store.entries.length) throw new Error('None of the selected snapping categories exist in these states');

    const bounds = boundsOf((await Promise.all(caches.map((c) => stateBoundary(c.state)))).flat());

    const file = `${FILE_PREFIX}snap-${stamp()}`;
    const out = path.join(tmp, `${file}.pmtiles`);
    const written = await writePMTiles(store, out, {
        tileType: PM_TILETYPE.mvt,
        tileCompression: PM_COMPRESSION.gzip,
        bounds,
        metadata: {
            name: `Snapping ${stateLabel(states)}`,
            description: `OSM lines for CloudTAK line snapping (${snapCategoryLabel(t.categories)}) - Terrain Data Downloader master snapping layer`,
            attribution: SNAP_ATTRIBUTION,
            type: 'overlay',
            format: 'pbf',
            vector_layers: [{
                id: SNAP_LAYER_OUT,
                description: 'Snapping lines from OSM Shortbread layers; `category` holds the snapping category id',
                minzoom: minZoomOf(store),
                maxzoom: 14,
                fields: { category: 'String', kind: 'String', surface: 'String', tracktype: 'String', bridge: 'Boolean', tunnel: 'Boolean', oneway: 'Boolean', link: 'Boolean', service: 'String', bicycle: 'String', horse: 'String' },
            }],
        },
    });
    await fsp.rm(store.file, { force: true });
    setStep(job, 'Uploading snapping layer', span[0] + (span[1] - span[0]) * 0.92);
    await S3.put(`public/${file}.pmtiles`, fs.createReadStream(out));
    await fsp.rm(out, { force: true });

    setStep(job, 'Registering snapping layer in CloudTAK', span[0] + (span[1] - span[0]) * 0.97);
    // collection must be null: the line tool's snapping list only returns basemaps without a collection
    const id = await upsertBasemap(job, old?.basemap ?? null, {
        name: `Snapping (${snapCategoryLabel(t.categories)}) - ${stateLabel(states)}`.slice(0, 120),
        url: tileUrl(file, 'mvt'),
        type: 'vector',
        format: 'mvt',
        minzoom: written.minZoom,
        maxzoom: written.maxZoom,
        bounds,
        attribution: SNAP_ATTRIBUTION,
        collection: null,
        snapping_enabled: true,
        snapping_layer: SNAP_LAYER_OUT,
    });

    s.snap = { basemap: id, file, states: caches.map((c) => c.state.slug), categories: t.categories, bytes: written.bytes, updated: now() };
    await writeSettings(s);
    if (old?.file && old.file !== file) await deleteHostedFile(job, old.file);
    await retireLegacy(job, t.legacy);

    job.summary.push(`Snapping updated: ${stateLabel(caches.map((c) => c.state))} (${(written.bytes / 1e6).toFixed(0)} MB)`);
    log(job, `Snapping: master layer ${id} updated (${(written.bytes / 1e6).toFixed(1)} MB)`);
}

function minZoomOf(store: TileStore): number {
    let min = 14;
    for (const e of store.entries) min = Math.min(min, tileIdZoom(e.tileId));
    return min;
}

async function runJob(job: JobT): Promise<void> {
    if (cancelFlags.has(job.id)) { job.status = 'cancelled'; return; }
    job.status = 'running';
    runningJob = job.id;
    job.updated = now();
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cloudtak-tdd-'));

    try {
        // Always start from the latest stored state, so queued batches stack onto each other
        setStep(job, 'Reading current layers', 0);
        const s = await readSettings(true);
        const legacy = await findLegacy(s);
        if (legacy.length) log(job, `Found ${legacy.length} layer(s) from an earlier plugin version - they will be merged into the master layers`);

        const t = target(job.request, s, legacy);
        if (!t.terrain.touched && !t.snap.touched) {
            job.summary.push('No changes');
            log(job, 'Nothing to change');
        }
        const both = t.terrain.touched && t.snap.touched;
        const split = both ? 0.4 : (t.terrain.touched ? 1 : 0);

        if (t.terrain.touched) await buildTerrain(job, s, t.terrain, tmp, [0, split]);
        if (t.snap.touched) await buildSnap(job, s, t.snap, tmp, [split, 1]);

        job.status = 'success';
        setStep(job, 'Complete', 1);
        log(job, 'Job complete');
    } catch (err) {
        const msg = errMessage(err);
        job.status = msg === 'Cancelled' ? 'cancelled' : 'failed';
        job.error = msg;
        log(job, `${job.status === 'cancelled' ? 'Cancelled' : 'ERROR'}: ${msg}`);
        console.error(`plugin-terrain-data-downloader job ${job.id} ${job.status}:`, err);
    } finally {
        cancelFlags.delete(job.id);
        runningJob = null;
        job.updated = now();
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
}

function enqueue(job: JobT): void {
    jobs.set(job.id, job);
    const ids = Array.from(jobs.keys());
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_JOBS_KEPT))) {
        const old = jobs.get(id);
        if (old && old.status !== 'running' && old.status !== 'queued') jobs.delete(id);
    }
    queue = queue.then(() => runJob(job)).catch((err) => console.error('plugin-terrain-data-downloader queue error', err));
}

function validateRequest(body: JobRequestT): void {
    for (const slug of [...body.add, ...body.remove]) {
        if (!STATE_BY_SLUG.has(slug)) throw new Err(400, null, `Unknown state: ${slug}`);
    }
    if (body.add.some((a) => body.remove.includes(a))) throw new Err(400, null, 'A state cannot be added and removed in the same request');
    if (!TERRAIN_ZOOMS.includes(body.terrain.maxzoom)) throw new Err(400, null, 'Unsupported terrain detail level');
    for (const c of body.snapping.categories) if (!SNAP_CATEGORY_IDS.has(c)) throw new Err(400, null, `Unknown snapping category: ${c}`);
    if (body.snapping.enabled && !body.snapping.categories.length) throw new Err(400, null, 'Select at least one snapping category');
    if ((body.add.length || body.remove.length) && !body.terrain.enabled && !body.snapping.enabled) throw new Err(400, null, 'Turn on terrain, snapping or both to choose which layers to change');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function router(schema: Schema, config: ConfigStateless) {
    CFG = config;

    await schema.get(`${PREFIX}/states`, {
        name: 'List States',
        group: 'PluginTerrainDataDownloader',
        description: 'US states/territories available to the Terrain Data Downloader',
        res: Type.Object({
            total: Type.Integer(),
            items: Type.Array(Type.Object({ slug: Type.String(), abbr: Type.String(), name: Type.String(), area: Type.Integer() })),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            res.json({ total: STATES.length, items: STATES.map(({ slug, abbr, name, area }) => ({ slug, abbr, name, area })) });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get(`${PREFIX}/categories`, {
        name: 'List Snapping Categories',
        group: 'PluginTerrainDataDownloader',
        description: 'Line categories that can be included in the snapping layer',
        res: Type.Object({
            total: Type.Integer(),
            items: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), description: Type.String(), default: Type.Boolean() })),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            const items = SNAP_CATEGORIES.map((c) => ({ id: c.id, label: c.label, description: c.description, default: c.default }));
            res.json({ total: items.length, items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get(`${PREFIX}/status`, {
        name: 'Get Status',
        group: 'PluginTerrainDataDownloader',
        description: 'The master terrain and snapping layers, the default terrain, and layers left by earlier plugin versions',
        res: Type.Object({
            terrain: Type.Union([Type.Null(), MasterTerrain]),
            snapping: Type.Union([Type.Null(), MasterSnap]),
            defaultTerrain: Type.Union([Type.Null(), Type.Integer()]),
            legacy: Type.Array(LegacyLayer),
            running: Type.Union([Type.Null(), Type.String()]),
            defaultCategories: Type.Array(Type.String()),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            const s = await readSettings(true);
            res.json({
                terrain: s.terrain,
                snapping: s.snap,
                defaultTerrain: await currentDefaultTerrain(),
                legacy: await findLegacy(s),
                running: runningJob,
                defaultCategories: DEFAULT_CATEGORIES,
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post(`${PREFIX}/plan`, {
        name: 'Plan Changes',
        group: 'PluginTerrainDataDownloader',
        description: 'Preview what a request would do to the master layers, with download estimates',
        body: JobRequest,
        res: Type.Object({
            terrain: Type.Object({
                touched: Type.Boolean(),
                states: Type.Integer(),
                maxzoom: Type.Integer(),
                tiles: Type.Integer(),
                newTiles: Type.Integer(),
                bytes: Type.Integer(),
                limit: Type.Integer(),
            }),
            snapping: Type.Object({
                touched: Type.Boolean(),
                states: Type.Integer(),
                downloads: Type.Array(Type.String()),
                download: Type.Integer(),
                categoriesChanged: Type.Boolean(),
            }),
        }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            validateRequest(req.body);
            const s = await readSettings(true);
            const legacy = await findLegacy(s);
            const t = target(req.body, s, legacy);

            let tiles = 0;
            let newTiles = 0;
            if (t.terrain.touched && t.terrain.states.length) {
                const next = await planTerrain(defs(t.terrain.states), t.terrain.maxzoom);
                tiles = next.tiles.length;
                newTiles = tiles;
                if (s.terrain && s.terrain.states.length) {
                    // Tiles already in the master (same areas, zooms it already has) are reused
                    const have = await planTerrain(defs(s.terrain.states), Math.min(s.terrain.maxzoom, t.terrain.maxzoom));
                    const ids = new Set(have.tiles.map((x) => x.id));
                    newTiles = next.tiles.filter((x) => !ids.has(x.id)).length;
                }
            }

            const downloads: string[] = [];
            if (t.snap.touched) {
                for (const slug of t.snap.states) {
                    const cached = !t.snap.refresh.has(slug) && await S3.exists(snapCacheKey(slug)).catch(() => false);
                    if (!cached) downloads.push(slug);
                }
            }
            let download = 0;
            await Promise.all(downloads.map(async (slug) => {
                download += await remoteSize(`${BBBIKE_PMTILES}/${slug}/${slug}.osm.pmtiles-shortbread.zip`).catch(() => 0);
            }));

            res.json({
                terrain: { touched: t.terrain.touched, states: t.terrain.states.length, maxzoom: t.terrain.maxzoom, tiles, newTiles, bytes: newTiles * TERRAIN_AVG_TILE_BYTES, limit: MAX_TERRAIN_TILES },
                snapping: { touched: t.snap.touched, states: t.snap.states.length, downloads, download, categoriesChanged: !!s.snap && !sameSet(s.snap.categories, t.snap.categories) },
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post(`${PREFIX}/job`, {
        name: 'Start Job',
        group: 'PluginTerrainDataDownloader',
        description: 'Queue a change to the master layers; jobs run one at a time, each on top of the previous result',
        body: JobRequest,
        res: JobSchema,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req, { admin: true });
            validateRequest(req.body);
            const job: JobT = {
                id: crypto.randomUUID(),
                status: 'queued',
                username: user.email,
                created: now(),
                updated: now(),
                request: req.body,
                step: 'Queued',
                progress: 0,
                log: [],
                summary: [],
            };
            const parts = [];
            if (req.body.add.length) parts.push(`add ${defs(req.body.add).map((s) => s.abbr).join(', ')}`);
            if (req.body.remove.length) parts.push(`remove ${defs(req.body.remove).map((s) => s.abbr).join(', ')}`);
            log(job, `Queued by ${user.email}: ${parts.join('; ') || 'apply layer settings'}`);
            enqueue(job);
            res.json(job);
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get(`${PREFIX}/job`, {
        name: 'List Jobs',
        group: 'PluginTerrainDataDownloader',
        description: 'Recent jobs on this API instance (kept in memory, cleared on API restart)',
        res: Type.Object({ total: Type.Integer(), items: Type.Array(JobSchema) }),
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            const items = Array.from(jobs.values()).reverse();
            res.json({ total: items.length, items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get(`${PREFIX}/job/:jobid`, {
        name: 'Get Job',
        group: 'PluginTerrainDataDownloader',
        description: 'Job status, progress and summary',
        params: Type.Object({ jobid: Type.String() }),
        res: JobSchema,
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            const job = jobs.get(req.params.jobid);
            if (!job) throw new Err(404, null, 'Job not found (the API may have restarted)');
            res.json(job);
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.delete(`${PREFIX}/job/:jobid`, {
        name: 'Cancel Job',
        group: 'PluginTerrainDataDownloader',
        description: 'Cancel a queued or running job (the master layers stay as they were)',
        params: Type.Object({ jobid: Type.String() }),
        res: JobSchema,
    }, async (req, res) => {
        try {
            await Auth.as_user(config, req, { admin: true });
            const job = jobs.get(req.params.jobid);
            if (!job) throw new Err(404, null, 'Job not found');
            if (job.status === 'queued' || job.status === 'running') {
                cancelFlags.add(job.id);
                log(job, 'Cancellation requested');
                if (job.status === 'queued') job.status = 'cancelled';
            }
            res.json(job);
        } catch (err) {
            Err.respond(err, res);
        }
    });
}

/** Pure helpers exported for the plugin's own tests - not used by CloudTAK */
export const __test = {
    zxyToTileId, tileIdZoom, serializeDirectory, deserializeDirectory, encodeHeader, decodeHeader,
    filterSnapTile, mergeOutTiles, SNAP_CATEGORIES, coverPolygon, writePMTiles, TileWriter, pmtilesEntries, readAt, decompress,
    planTerrain, downloadZipEntry, stateBoundary, STATE_BY_SLUG, PM_TILETYPE, PM_COMPRESSION, PM_HEADER_LEN,
    target, statesFromLegacyFile, fileFromUrl,
};
