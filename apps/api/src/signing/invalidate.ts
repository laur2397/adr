import { audit, type AuditActor } from '../audit/audit.js';
import { query, type Db } from '../core/db.js';

async function invalidate(db: Db, actor: AuditActor, ids: string[], reason: string): Promise<number> {
  if (!ids.length) return 0;
  await query(db, `update signature set status = 'invalidated', invalidated_at = now(), invalidated_reason = $2 where id = any($1::uuid[])`, [ids, reason]);
  for (const id of ids) await audit(db, actor, { action: 'signature.invalidate', entityType: 'signature', entityId: id, newValue: { reason } });
  return ids.length;
}

/** A regenerated or replaced document needs to be signed again. */
export async function invalidateDocumentSignatures(db: Db, actor: AuditActor, documentId: string, reason: string): Promise<number> {
  const rows = await query(db, `select id from signature where document_id = $1 and status in ('signed', 'pending')`, [documentId]);
  return invalidate(db, actor, rows.map((r) => r.id), reason);
}

/** On a return to an earlier step, signatures given since that step was last entered no longer hold. */
export async function invalidateSignaturesSince(db: Db, actor: AuditActor, instanceId: string, since: string, reason: string): Promise<number> {
  const rows = await query(db, `select id from signature where instance_id = $1 and status in ('signed', 'pending') and created_at >= $2`, [
    instanceId,
    since,
  ]);
  return invalidate(db, actor, rows.map((r) => r.id), reason);
}
