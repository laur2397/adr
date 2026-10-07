import pg from 'pg';
import { config } from './config.js';

// numeric -> string (exact money), int8 -> number (counters stay far below 2^53), date -> 'YYYY-MM-DD'.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    connectionString: config.databaseUrl,
    max: Number(process.env.DB_POOL_MAX ?? 20),
    options: '-c search_path=flux,public',
  });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export async function query<T extends pg.QueryResultRow = Record<string, any>>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = Record<string, any>>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await query<T>(db, sql, params);
  if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
  return rows[0]!;
}

export async function maybeOne<T extends pg.QueryResultRow = Record<string, any>>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(db, sql, params);
  return rows[0] ?? null;
}

/** Runs fn in a transaction; rolls back on error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    const after = (err as { onRollback?: () => Promise<void> }).onRollback;
    if (after) await after().catch((e) => console.error('onRollback failed', e));
    throw err;
  } finally {
    client.release();
  }
}
