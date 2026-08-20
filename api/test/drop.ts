import fs from 'node:fs';
import postgres from 'postgres';

/**
 * Reset the test database to a pristine post-migration state
 *
 * When the applied migrations match the migrations folder the tables are
 * simply truncated, which is much faster than rebuilding the schema.
 * If they differ (e.g. a branch switch changed the migration set) fall back
 * to dropping everything so the subsequent migration run starts clean.
 */
export default async function drop(connstr: string) {
    if (process.env.ALLOW_TEST_DB_RESET !== 'true') {
        throw new Error(
            'Refusing to reset database: ALLOW_TEST_DB_RESET=true is not set. '
            + 'This function TRUNCATEs (or DROPs) every table in the target database - '
            + 'it must never run against a real database, even by accident (e.g. a local '
            + '`docker compose`/`docker run` invocation resolving to a real running stack '
            + 'via a shared network/container name). Set ALLOW_TEST_DB_RESET=true only when '
            + 'POSTGRES points at a disposable test database.',
        );
    }

    const client = postgres(connstr, {
        onnotice: () => {},
    });

    const tables = (await client`
        SELECT tablename FROM pg_tables
        WHERE
            schemaname = 'public'
            AND tablename != 'spatial_ref_sys'
    `).map(r => r.tablename);

    let applied = -1;
    try {
        applied = Number((await client`
            SELECT count(*) AS count FROM drizzle.__drizzle_migrations
        `)[0].count);
    } catch {
        // Journal table missing - fresh or pre-drizzle database
    }

    const available = fs.readdirSync(new URL('../migrations', import.meta.url))
        .filter(f => f.endsWith('.sql'))
        .length;

    if (applied === available && tables.length) {
        await client.unsafe(`
            TRUNCATE TABLE ${tables.map(t => `"${t}"`).join(', ')}
            RESTART IDENTITY CASCADE
        `);
    } else {
        await client`DROP SCHEMA IF EXISTS drizzle CASCADE`;
        for (const table of tables) {
            await client.unsafe(`DROP TABLE "${table}" CASCADE`);
        }
    }

    await client.end();
}
