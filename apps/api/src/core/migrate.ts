import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url));

/** Applies db/migrations/*.sql in name order, each in its own transaction, once. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext('flux.migrate'))`);
    await client.query(`create schema if not exists flux`);
    await client.query(`create table if not exists flux.schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query<{ name: string }>(`select name from flux.schema_migrations`)).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(MIGRATIONS_DIR + file, 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(`insert into flux.schema_migrations (name) values ($1)`, [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      log(`applied ${file}`);
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query(`select pg_advisory_unlock(hashtext('flux.migrate'))`).catch(() => undefined);
    client.release();
  }
}
