// api/lib/replay-recorder.ts
//
// Matches the working pattern already used by this instance's
// plugin-dispatcher.ts: raw CREATE TABLE IF NOT EXISTS via
// config.pg.execute(sql`...`), not Drizzle schema.ts / migrations. Owns two
// tables: replay_events (recording sessions) and replay_cot (recorded CoT,
// event-scoped not connection-scoped).
//
// Bootstrap is idempotent and defensive: called both from the route file's
// load-time bootstrap AND on first use here, so table creation doesn't
// depend on route/connection boot ordering.

import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import Config from './config.js';
import CoT, { CoTParser } from '@tak-ps/node-cot';
import ConnectionConfig from './connection-config.js';

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
    } catch (err) {
        console.error('[replay] table bootstrap failed', err);
    }
}

function contentHash(xml: string): string {
    const normalized = xml.replace(/\s(?:time|start|stale)="[^"]*"/g, '');
    return crypto.createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

export default class Recorder {
    config: Config;
    activeEvent: { id: number; name: string } | null = null;
    recentHashes: Map<string, string> = new Map();
    bootstrapped = false;

    constructor(config: Config) {
        this.config = config;
    }

    private async ensureBootstrapped(): Promise<void> {
        if (this.bootstrapped) return;
        await bootstrapReplayTables(this.config);
        this.bootstrapped = true;
    }

    active(): boolean {
        return this.activeEvent !== null;
    }

    async refresh(): Promise<void> {
        await this.ensureBootstrapped();

        const rows = await this.config.pg.execute(sql`
            SELECT id, name FROM replay_events WHERE status = 'recording' LIMIT 1
        `) as unknown as { id: number; name: string }[];

        this.activeEvent = rows.length ? { id: rows[0].id, name: rows[0].name } : null;
        if (!this.activeEvent) this.recentHashes.clear();
    }

    async start(name: string, username: string): Promise<number> {
        await this.ensureBootstrapped();
        await this.refresh();
        if (this.activeEvent) {
            throw new Error(`Recording "${this.activeEvent.name}" is already active`);
        }

        const rows = await this.config.pg.execute(sql`
            INSERT INTO replay_events (name, username, status)
            VALUES (${name}, ${username}, 'recording')
            RETURNING id, name
        `) as unknown as { id: number; name: string }[];

        this.activeEvent = { id: rows[0].id, name: rows[0].name };
        this.recentHashes.clear();
        return rows[0].id;
    }

    async stop(): Promise<void> {
        if (!this.activeEvent) return;

        await this.config.pg.execute(sql`
            UPDATE replay_events SET status = 'stopped', ended_at = now()
            WHERE id = ${this.activeEvent.id}
        `);

        this.activeEvent = null;
        this.recentHashes.clear();
    }

    async record(conn: ConnectionConfig, cots: CoT[]): Promise<void> {
        if (!this.activeEvent || cots.length === 0) return;
        await this.ensureBootstrapped();

        for (const cot of cots) {
            const uid = cot.uid();
            if (!uid) continue;

            const xml = await CoTParser.to_xml(cot);
            const sha = contentHash(xml);

            if (this.recentHashes.get(uid) === sha) continue;
            this.recentHashes.set(uid, sha);
            if (this.recentHashes.size > 10000) {
                let dropped = 0;
                for (const k of this.recentHashes.keys()) {
                    this.recentHashes.delete(k);
                    if (++dropped >= 2000) break;
                }
            }

            const connId = typeof conn.id === 'number' ? conn.id : null;
            const cotType = cot.type();

            try {
                await this.config.pg.execute(sql`
                    INSERT INTO replay_cot (event, connection, source, uid, cot_type, sha256, cot_xml)
                    VALUES (${this.activeEvent.id}, ${connId}, 'gateway', ${uid}, ${cotType}, ${sha}, ${xml})
                `);
            } catch (err) {
                console.error('[replay] record insert failed', err);
            }
        }
    }
}
