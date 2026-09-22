// CloudTAK lints copied plugin routes with its OWN house-style rules, which differ across
// versions: @stylistic/brace-style flips between 13.2 (Stroustrup) and 13.3 (1TBS), and
// isn't even defined on 12.82 (naming it in a disable errors there). A plugin can't satisfy
// every CloudTAK version, so opt this route file out of CloudTAK's lint — the plugin repo
// owns its correctness (vue-tsc/eslint in dev).
/* eslint-disable */
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
// Same CloudTAK >= 13.45 (hub/api split) requirement as plugin-dispatcher.ts: routes live
// in api/stateless/routes/, shared libs in api/common/, and route files receive
// ConfigStateless (extends the base Config owning pg/models/server — raw drizzle SQL below
// is unaffected by the split).
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';

// Server-side store for the Simulator plugin roster: one row per simulated unit, keyed by
// its CoT uid, so the roster + control state (mode, heading, waypoints, etc.) survive
// across a browser/computer change for the same login. Lives in CloudTAK's own Postgres,
// same ownership pattern as plugin-dispatcher.ts — we own this ONE table via
// CREATE TABLE IF NOT EXISTS (config.pg is a drizzle PgDatabase, so config.pg.execute(sql`...`)
// runs raw SQL); this does not touch CloudTAK's drizzle migrations, and the gis DB survives
// API image rebuilds. Auto-loaded by schema.load('./routes/').
//
// This route is a write-behind mirror only: the client (sim-store.ts) still owns the live
// in-memory movement tick loop and CoT injection (sim-marker.ts). The server never computes
// or advances unit motion — it just stores whatever full-state snapshot the client PUTs.

interface UnitRow {
    uid: string;
    callsign: string;
    type: string;
    lat: number;
    lon: number;
    altitude_ft: number;
    course_deg: number;
    speed_kts: number;
    mode: string;
    mode_params: unknown;
    home_lat: number;
    home_lon: number;
    updated_at: string;
}

// drizzle's execute() returns the driver RowList; cast to the row shape we SELECTed.
async function query<T>(config: ConfigStateless, statement: ReturnType<typeof sql>): Promise<T[]> {
    const result = await config.pg.execute(statement);
    return result as unknown as T[];
}

// jsonb columns can come back from the driver as a (possibly double-encoded) JSON string.
// Unwrap to a real object so the client always gets a plain mode_params record.
function asObject(v: unknown): Record<string, unknown> {
    let x: unknown = v;
    for (let i = 0; i < 4 && typeof x === 'string'; i++) {
        try {
            x = JSON.parse(x);
        } catch {
            return {};
        }
    }
    return (x && typeof x === 'object' && !Array.isArray(x)) ? x as Record<string, unknown> : {};
}

function mapUnit(row: UnitRow): UnitRow & { mode_params: Record<string, unknown> } {
    return { ...row, mode_params: asObject(row.mode_params) };
}

export default async function router(schema: Schema, config: ConfigStateless) {
    // Idempotent schema bootstrap. Best-effort so a transient DB hiccup can't block CloudTAK
    // startup; CREATE TABLE IF NOT EXISTS is safe to re-run on every load.
    try {
        await config.pg.execute(sql`
            CREATE TABLE IF NOT EXISTS simulator_units (
                uid         TEXT PRIMARY KEY,
                callsign    TEXT NOT NULL,
                type        TEXT NOT NULL,
                lat         DOUBLE PRECISION NOT NULL,
                lon         DOUBLE PRECISION NOT NULL,
                altitude_ft DOUBLE PRECISION NOT NULL DEFAULT 0,
                course_deg  DOUBLE PRECISION NOT NULL DEFAULT 0,
                speed_kts   DOUBLE PRECISION NOT NULL DEFAULT 0,
                mode        TEXT NOT NULL DEFAULT 'static',
                mode_params JSONB NOT NULL DEFAULT '{}'::jsonb,
                home_lat    DOUBLE PRECISION NOT NULL,
                home_lon    DOUBLE PRECISION NOT NULL,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
    } catch (err) {
        console.error('[simulator] table bootstrap failed', err);
    }

    await schema.get('/simulator/units', {
        name: 'List Simulated Units',
        group: 'Simulator',
        description: 'List all simulated units (the roster load for the Simulator panel)',
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.is_auth(config, req);
            const units = await query<UnitRow>(config, sql`
                SELECT uid, callsign, type, lat, lon, altitude_ft, course_deg, speed_kts,
                       mode, mode_params, home_lat, home_lon, updated_at
                FROM simulator_units ORDER BY updated_at ASC
            `);
            res.json({ units: units.map(mapUnit) });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.put('/simulator/units/:uid', {
        name: 'Upsert Simulated Unit',
        group: 'Simulator',
        description: 'Create or update a simulated unit\'s full state',
        params: Type.Object({ uid: Type.String() }),
        body: Type.Object({
            callsign: Type.String(),
            type: Type.String(),
            lat: Type.Number(),
            lon: Type.Number(),
            altitude_ft: Type.Number(),
            course_deg: Type.Number(),
            speed_kts: Type.Number(),
            mode: Type.String(),
            mode_params: Type.Any(),
            home_lat: Type.Number(),
            home_lon: Type.Number(),
        }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.is_auth(config, req);
            const b = req.body;
            const modeParams = JSON.stringify(b.mode_params ?? {});
            const units = await query<UnitRow>(config, sql`
                INSERT INTO simulator_units
                    (uid, callsign, type, lat, lon, altitude_ft, course_deg, speed_kts, mode, mode_params, home_lat, home_lon, updated_at)
                VALUES
                    (${req.params.uid}, ${b.callsign}, ${b.type}, ${b.lat}, ${b.lon}, ${b.altitude_ft},
                     ${b.course_deg}, ${b.speed_kts}, ${b.mode}, ${modeParams}::jsonb, ${b.home_lat}, ${b.home_lon}, now())
                ON CONFLICT (uid) DO UPDATE SET
                    callsign    = EXCLUDED.callsign,
                    type        = EXCLUDED.type,
                    lat         = EXCLUDED.lat,
                    lon         = EXCLUDED.lon,
                    altitude_ft = EXCLUDED.altitude_ft,
                    course_deg  = EXCLUDED.course_deg,
                    speed_kts   = EXCLUDED.speed_kts,
                    mode        = EXCLUDED.mode,
                    mode_params = EXCLUDED.mode_params,
                    home_lat    = EXCLUDED.home_lat,
                    home_lon    = EXCLUDED.home_lon,
                    updated_at  = now()
                RETURNING uid, callsign, type, lat, lon, altitude_ft, course_deg, speed_kts,
                          mode, mode_params, home_lat, home_lon, updated_at
            `);
            res.json({ unit: mapUnit(units[0]) });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.delete('/simulator/units/:uid', {
        name: 'Delete Simulated Unit',
        group: 'Simulator',
        description: 'Remove a simulated unit from the roster',
        params: Type.Object({ uid: Type.String() }),
        res: Type.Any(),
    }, async (req, res) => {
        try {
            await Auth.is_auth(config, req);
            await config.pg.execute(sql`DELETE FROM simulator_units WHERE uid = ${req.params.uid}`);
            res.json({ status: 200, message: 'deleted' });
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
