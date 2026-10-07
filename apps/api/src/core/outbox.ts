import { query, type Db } from './db.js';

/**
 * Queues a side effect to run after the current transaction commits (transactional outbox).
 * The worker picks it up; if the transaction rolls back, the job disappears with it.
 */
export async function enqueue(db: Db, kind: string, payload: Record<string, unknown>, runAfter?: Date): Promise<void> {
  await query(db, `insert into job_outbox (kind, payload, run_after) values ($1, $2, coalesce($3, now()))`, [
    kind,
    JSON.stringify(payload),
    runAfter ?? null,
  ]);
}
