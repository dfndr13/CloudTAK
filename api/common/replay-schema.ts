// api/common/replay-schema.ts
//
// Split out of replay-recorder.ts during the stateful/stateless/common
// refactor merge: bootstrapReplayTables() only touches config.pg (raw
// Postgres), no ConnectionPool dependency, so it lives here in common
// rather than in stateful/lib/replay-recorder.ts - both the stateful
// Recorder (api/stateful/lib/replay-recorder.ts) and the stateless
// /replay/* routes (api/stateless/routes/replay.ts) need to call it, and
// stateless must not import from stateful.
//
// Matches the working pattern already used by this instance's
// plugin-dispatcher.ts: raw CREATE TABLE IF NOT EXISTS via
// config.pg.execute(sql`...`), not Drizzle schema.ts / migrations. Owns two
// tables: replay_events (recording sessions) and replay_cot (recorded CoT,
// event-scoped not connection-scoped).
//
// Bootstrap is idempotent and defensive: called both from the route file's
// load-time bootstrap AND on first use in Recorder, so table creation
// doesn't depend on route/connection boot ordering.

import { sql } from 'drizzle-orm';
import type Config from './config.js';

export interface ReplayEventRow {
    id: number;
    name: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    username: string;
}

export async function bootstrapReplayTables(config: Config): Promise<void> {
    try {
        await config.pg.execute(sql`
            CREATE TABLE IF NOT EXISTS replay_events (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                ended_at    TIMESTAMPTZ,
                status      TEXT NOT NULL DEFAULT 'recording',
                username    TEXT NOT NULL
            )
        `);
        await config.pg.execute(sql`
            CREATE TABLE IF NOT EXISTS replay_cot (
                id           BIGSERIAL PRIMARY KEY,
                event        INTEGER NOT NULL REFERENCES replay_events(id) ON DELETE CASCADE,
                connection   INTEGER,
                source       TEXT NOT NULL DEFAULT 'gateway',
                uid          TEXT NOT NULL,
                cot_type     TEXT,
                recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                sha256       TEXT NOT NULL,
                cot_xml      TEXT NOT NULL
            )
        `);
        await config.pg.execute(sql`
            CREATE INDEX IF NOT EXISTS replay_cot_event_time_idx ON replay_cot (event, recorded_at)
        `);
        // 'cot' rows are a normal CoT snapshot (live traffic, or a direct-write
        // capture of a drawn/authored feature). 'removed' rows are a marker
        // saying "this uid stopped existing here" - written when a user
        // explicitly deletes one of their own drawn features via the reliable
        // db.remove() path, since real CoT delete tasking (t-x-d-d) isn't
        // reliably delivered for features that were never Shared in the
        // first place. Added via ALTER ... IF NOT EXISTS since replay_cot
        // may already exist from before this column was introduced.
        await config.pg.execute(sql`
            ALTER TABLE replay_cot ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cot'
        `);
    } catch (err) {
        console.error('[replay] table bootstrap failed', err);
    }
}
