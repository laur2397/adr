import { normalizeCui } from '@flux/validators';
import { audit, type AuditActor } from '../audit/audit.js';
import { today } from '../core/config.js';
import { maybeOne, one, query, type Db } from '../core/db.js';
import { notFound } from '../core/errors.js';

export interface CorrespondentInput {
  name: string;
  cui?: string | null;
  email?: string | null;
  address?: string | null;
  beneficiaryId?: string | null;
}

/** Finds a correspondent by CUI (or e-mail when there is no CUI) or creates it. */
export async function upsertCorrespondent(db: Db, organizationId: string, c: CorrespondentInput): Promise<string> {
  const cui = c.cui ? normalizeCui(c.cui) : null;
  const email = c.email?.trim().toLowerCase() || null;
  if (cui) {
    const found = await maybeOne(db, `select id from correspondent where organization_id = $1 and cui = $2`, [organizationId, cui]);
    if (found) return found.id;
  } else if (email) {
    const found = await maybeOne(db, `select id from correspondent where organization_id = $1 and cui is null and lower(email) = $2`, [organizationId, email]);
    if (found) return found.id;
  }
  const row = await one(
    db,
    `insert into correspondent (organization_id, name, cui, email, address, beneficiary_id)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [organizationId, c.name, cui, email, c.address ?? null, c.beneficiaryId ?? null],
  );
  return row.id;
}

export interface EntryInput {
  registerKey: string;
  direction: 'in' | 'out' | 'internal';
  subject: string;
  senderId?: string | null;
  recipientId?: string | null;
  internalDepartmentId?: string | null;
  channel?: string | null;
  instanceId?: string | null;
  documentId?: string | null;
  relatedEntryId?: string | null;
  archiveFileId?: string | null;
  extra?: Record<string, unknown>;
}

export interface RegisterEntry {
  id: string;
  number: number;
  number_display: string;
  registered_at: string;
  year: number;
  register_key: string;
}

export function formatNumber(format: string, n: number, isoDay: string): string {
  const [yyyy, mm, dd] = isoDay.split('-') as [string, string, string];
  return format.replaceAll('{n}', String(n)).replaceAll('{dd}', dd).replaceAll('{mm}', mm).replaceAll('{yyyy}', yyyy);
}

/**
 * Registers a document. The number comes from next_register_number(), which keeps the counter
 * row locked until this transaction commits: no duplicates, and no gaps on rollback.
 * Keep the surrounding transaction short.
 */
export async function createEntry(db: Db, actor: AuditActor & { userId: string }, input: EntryInput): Promise<RegisterEntry> {
  const reg = await maybeOne(db, `select id, number_format, yearly_reset from register where organization_id = $1 and key = $2 and active`, [
    actor.organizationId,
    input.registerKey,
  ]);
  if (!reg) throw notFound(`Registrul „${input.registerKey}”`);
  const day = today();
  const year = reg.yearly_reset ? Number(day.slice(0, 4)) : 0;
  const { n } = await one(db, `select next_register_number($1, $2) as n`, [reg.id, year]);
  const display = formatNumber(reg.number_format, n, day);
  const entry = await one(
    db,
    `insert into register_entry (register_id, year, number, number_display, direction, sender_id, recipient_id, internal_department_id,
                                 subject, channel, instance_id, document_id, related_entry_id, archive_file_id, extra, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning id, number, number_display, registered_at, year`,
    [
      reg.id, year, n, display, input.direction, input.senderId ?? null, input.recipientId ?? null, input.internalDepartmentId ?? null,
      input.subject, input.channel ?? null, input.instanceId ?? null, input.documentId ?? null, input.relatedEntryId ?? null,
      input.archiveFileId ?? null, JSON.stringify(input.extra ?? {}), actor.userId,
    ],
  );
  await audit(db, actor, {
    action: 'register.entry.create',
    entityType: 'register_entry',
    entityId: entry.id,
    newValue: { register: input.registerKey, number: display, direction: input.direction, subject: input.subject, instanceId: input.instanceId ?? null },
  });
  return { ...entry, register_key: input.registerKey } as RegisterEntry;
}

export async function lastEntryForInstance(db: Db, instanceId: string, registerKey: string, direction: string) {
  return maybeOne(
    db,
    `select e.* from register_entry e join register r on r.id = e.register_id
      where e.instance_id = $1 and r.key = $2 and e.direction = $3
      order by e.registered_at desc, e.number desc limit 1`,
    [instanceId, registerKey, direction],
  );
}

export async function entriesForInstance(db: Db, instanceId: string) {
  return query(
    db,
    `select e.id, r.key as register_key, r.name as register_name, e.number_display, e.registered_at, e.direction, e.subject
       from register_entry e join register r on r.id = e.register_id
      where e.instance_id = $1 order by e.registered_at`,
    [instanceId],
  );
}
