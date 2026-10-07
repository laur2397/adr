import type { Db } from '../core/db.js';

export interface AuditActor {
  organizationId: string;
  userId: string | null;
  onBehalfOf?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/** Audit actions published to webhooks, under a stable public event name. */
const WEBHOOK_EVENTS: Record<string, string> = {
  'instance.create': 'dossier.created',
  'instance.transition': 'dossier.step_completed',
  'instance.return': 'dossier.returned',
  'instance.finish': 'dossier.finished',
  'register.entry.create': 'registry.entry_created',
  'signature.complete': 'document.signed',
  'debt.create': 'debt.created',
  'debt.payment': 'debt.payment_recorded',
};

/**
 * Appends an event to the hash-chained audit log. Call it inside the same transaction as the
 * change it describes, so a change without its audit event cannot be committed.
 */
export async function audit(db: Db, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_event (organization_id, actor_user_id, on_behalf_of_user_id, action, entity_type, entity_id, old_value, new_value, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.organizationId,
      actor.userId,
      actor.onBehalfOf ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
      entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
      actor.ip ?? null,
      actor.userAgent ?? null,
    ],
  );
  const event = WEBHOOK_EVENTS[entry.action];
  if (event) {
    // One delivery job per subscribed webhook, in the same transaction as the change.
    await db.query(
      `insert into job_outbox (kind, payload)
       select 'webhook', jsonb_build_object('webhookId', w.id, 'event', $2::text, 'entityType', $3::text, 'entityId', $4::text, 'data', $5::jsonb, 'occurredAt', now())
         from webhook w where w.organization_id = $1 and w.active and $2 = any(w.events)`,
      [actor.organizationId, event, entry.entityType, entry.entityId, JSON.stringify(entry.newValue ?? {})],
    );
  }
}

export const PUBLIC_EVENTS = Object.values(WEBHOOK_EVENTS);
