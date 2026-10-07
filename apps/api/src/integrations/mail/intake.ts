import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { audit, type AuditActor } from '../../audit/audit.js';
import { getPool, maybeOne, one, query, tx, type Db } from '../../core/db.js';
import { AppError, badRequest, notFound } from '../../core/errors.js';
import { addVersion } from '../../documents/service.js';
import { getFile, putFile } from '../../documents/storage.js';
import { actorOf, type CurrentUser } from '../../identity/context.js';
import { notifyUsers } from '../../notifications/service.js';
import { createEntry, lastEntryForInstance, upsertCorrespondent } from '../../registry/service.js';
import { reindexInstance } from '../../search/index.js';
import { startInstance } from '../../workflow/engine.js';

/** Registration numbers as they appear in subjects: "4812/07.10.2026", "nr. 4812 / 07.10.2026". */
const NUMBER_RE = /(\d{1,7})\s*\/\s*(\d{2}\.\d{2}\.\d{4})/;

export interface StoredMail {
  id: string;
  duplicate: boolean;
}

/**
 * Parses a raw e-mail and puts it in the registry's queue (status pending). Nothing is numbered
 * until an operator confirms it. The original .eml and the attachments are stored content-addressed.
 */
export async function storeIncomingMail(db: Db, organizationId: string, raw: Buffer): Promise<StoredMail> {
  const parsed = await simpleParser(raw);
  const messageId = parsed.messageId ?? `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const existing = await maybeOne(db, `select id from mail_message where organization_id = $1 and message_id = $2`, [organizationId, messageId]);
  if (existing) return { id: existing.id, duplicate: true };
  const from = parsed.from?.value[0];
  if (!from?.address) throw badRequest('Mesajul nu are expeditor.');
  const stored = await putFile(raw);
  const attachments = [];
  for (const a of parsed.attachments ?? []) {
    const f = await putFile(a.content);
    attachments.push({ fileName: a.filename ?? 'atasament', mimeType: a.contentType, size: a.size, storageKey: f.storageKey });
  }
  const subject = (parsed.subject ?? '(fără subiect)').trim().slice(0, 500);
  const match = NUMBER_RE.exec(subject);
  const suggested = match
    ? await maybeOne(
        db,
        `select e.instance_id from register_entry e join register r on r.id = e.register_id
          where r.organization_id = $1 and e.number_display like $2 || '%' and e.instance_id is not null order by e.registered_at desc limit 1`,
        [organizationId, `${match[1]}/${match[2]}`],
      )
    : null;
  const toAddress = Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : (parsed.to?.text ?? null);
  const row = await one(
    db,
    `insert into mail_message (organization_id, message_id, from_address, from_name, to_address, subject, received_at, body_text, status,
                               raw_storage_key, attachments, suggested_instance_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11) returning id`,
    [organizationId, messageId, from.address.toLowerCase(), from.name || null, toAddress, subject, parsed.date ?? new Date(),
     (parsed.text ?? '').slice(0, 20000), stored.storageKey, JSON.stringify(attachments), suggested?.instance_id ?? null],
  );
  return { id: row.id, duplicate: false };
}

async function addMailDocuments(db: Db, user: CurrentUser, mail: Record<string, any>, instanceId: string | null): Promise<string> {
  const doc = await one(
    db,
    `insert into document (organization_id, instance_id, doc_type, title, created_by) values ($1, $2, 'email', $3, $4) returning id`,
    [user.organizationId, instanceId, `E-mail: ${mail.subject}`, user.id],
  );
  await addVersion(db, { documentId: doc.id, content: await getFile(mail.raw_storage_key), fileName: 'mesaj.eml', mimeType: 'message/rfc822', source: 'email', createdBy: user.id });
  for (const a of mail.attachments as Array<{ fileName: string; mimeType: string; storageKey: string }>) {
    const d = await one(
      db,
      `insert into document (organization_id, instance_id, doc_type, title, created_by) values ($1, $2, 'email_attachment', $3, $4) returning id`,
      [user.organizationId, instanceId, a.fileName, user.id],
    );
    await addVersion(db, { documentId: d.id, content: await getFile(a.storageKey), fileName: a.fileName, mimeType: a.mimeType, source: 'email', createdBy: user.id });
  }
  return doc.id;
}

export type MailAction =
  | { action: 'register'; startProcess?: { definitionKey: string; fields?: Record<string, unknown> } }
  | { action: 'attach'; instanceId: string }
  | { action: 'ignore'; reason: string };

/** The operator's decision for a queued message: register it, attach it to a dossier, or ignore it. */
export async function processMail(user: CurrentUser, mailId: string, decision: MailAction) {
  return tx(async (db) => {
    const mail = await maybeOne(db, `select * from mail_message where id = $1 and organization_id = $2 for update`, [mailId, user.organizationId]);
    if (!mail) throw notFound('Mesajul');
    if (mail.status !== 'pending') throw new AppError(409, 'Mesajul a fost deja procesat.');
    const actor = actorOf(user) as AuditActor & { userId: string };
    if (decision.action === 'ignore') {
      if (!decision.reason?.trim()) throw badRequest('Completați motivul (ex. spam, mesaj publicitar).');
      await query(db, `update mail_message set status = 'ignored', error = $2, processed_at = now(), processed_by = $3 where id = $1`, [mailId, decision.reason.trim(), user.id]);
      await audit(db, actor, { action: 'mail.ignore', entityType: 'mail_message', entityId: mailId, newValue: { reason: decision.reason } });
      return { status: 'ignored' };
    }
    const senderId = await upsertCorrespondent(db, user.organizationId, { name: mail.from_name ?? mail.from_address, email: mail.from_address });
    if (decision.action === 'attach') {
      const inst = await maybeOne(db, `select id, title from instance where id = $1 and organization_id = $2 and status = 'active'`, [decision.instanceId, user.organizationId]);
      if (!inst) throw notFound('Dosarul (activ)');
      const previousOut = await lastEntryForInstance(db, inst.id, 'general', 'out');
      const docId = await addMailDocuments(db, user, mail, inst.id);
      const entry = await createEntry(db, actor, {
        registerKey: 'general',
        direction: 'in',
        subject: mail.subject,
        senderId,
        channel: 'email',
        instanceId: inst.id,
        documentId: docId,
        relatedEntryId: previousOut?.id ?? null,
      });
      const assignees = await query(db, `select assignee_user_id from task where instance_id = $1 and status = 'open' and assignee_user_id is not null`, [inst.id]);
      await notifyUsers(db, assignees.map((a) => a.assignee_user_id), { kind: 'mail_attached', instanceId: inst.id, title: `E-mail nou atașat la dosar: ${mail.subject}` });
      await query(db, `update mail_message set status = 'attached', instance_id = $2, register_entry_id = $3, processed_at = now(), processed_by = $4 where id = $1`, [mailId, inst.id, entry.id, user.id]);
      await reindexInstance(db, inst.id);
      return { status: 'attached', instanceId: inst.id, number: entry.number_display };
    }
    let instanceId: string | null = null;
    if (decision.startProcess) {
      instanceId = await startInstance(db, user, {
        definitionKey: decision.startProcess.definitionKey,
        title: mail.subject,
        fields: { subject: mail.subject, sender_name: mail.from_name ?? mail.from_address, ...(decision.startProcess.fields ?? {}) },
      });
    }
    const docId = await addMailDocuments(db, user, mail, instanceId);
    const entry = await createEntry(db, actor, { registerKey: 'general', direction: 'in', subject: mail.subject, senderId, channel: 'email', instanceId, documentId: docId });
    if (instanceId) {
      await query(db, `update instance set reference_no = $2 where id = $1 and reference_no is null`, [instanceId, entry.number_display]);
      await reindexInstance(db, instanceId);
    }
    await query(db, `update mail_message set status = 'registered', instance_id = $2, register_entry_id = $3, processed_at = now(), processed_by = $4 where id = $1`, [mailId, instanceId, entry.id, user.id]);
    return { status: 'registered', instanceId, number: entry.number_display };
  });
}

/**
 * Polls the mailbox in IMAP_URL (imaps://user:password@host:993/INBOX) for unseen messages and queues
 * them. Messages are flagged as seen only after they are stored.
 */
export async function pollMailbox(): Promise<number> {
  const url = process.env.IMAP_URL;
  if (!url) return 0;
  const { ImapFlow } = await import('imapflow');
  const u = new URL(url);
  const org = await maybeOne(getPool(), `select id from organization order by created_at limit 1`);
  if (!org) return 0;
  const client = new ImapFlow({
    host: u.hostname,
    port: Number(u.port || (u.protocol === 'imaps:' ? 993 : 143)),
    secure: u.protocol === 'imaps:',
    auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) },
    logger: false,
  });
  await client.connect();
  let count = 0;
  try {
    const lock = await client.getMailboxLock(decodeURIComponent(u.pathname.slice(1)) || 'INBOX');
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!msg.source) continue;
        await tx((db) => storeIncomingMail(db, org.id, msg.source as Buffer));
        await client.messageFlagsAdd({ uid: String(msg.uid) }, ['\\Seen'], { uid: true });
        count++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return count;
}
