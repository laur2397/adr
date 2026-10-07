import nodemailer from 'nodemailer';
import { config } from '../core/config.js';
import { getPool, maybeOne, query, tx } from '../core/db.js';
import { scanDeadlines } from '../deadlines/service.js';
import { generateDocument, latestVersion, readVersion } from '../documents/service.js';

type Job = { id: number; kind: string; payload: Record<string, any>; attempts: number };

let transport: nodemailer.Transporter | null | undefined;
function mailer(): nodemailer.Transporter | null {
  if (transport === undefined) transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  return transport;
}

async function sendMail(to: string[], subject: string, text: string, attachments: Array<{ filename: string; content: Buffer }> = []) {
  const m = mailer();
  if (!m || !to.length) return 'skipped (SMTP not configured or no recipients)';
  await m.sendMail({ from: config.mailFrom, to, subject, text, attachments });
  return 'sent';
}

async function run(job: Job): Promise<string> {
  const pool = getPool();
  switch (job.kind) {
    case 'generate_document': {
      const inst = await maybeOne(pool, `select organization_id, started_by, status from instance where id = $1`, [job.payload.instanceId]);
      if (!inst || inst.status !== 'active') return 'skipped (instance closed)';
      const doc = await maybeOne(pool, `select id from document where instance_id = $1 and doc_key = $2`, [job.payload.instanceId, job.payload.docKey]);
      // A draft generated on entering a step must not replace a version someone already signed.
      if (doc) {
        const signed = await maybeOne(pool, `select 1 from signature where document_id = $1 and status = 'signed'`, [doc.id]);
        if (signed) return 'skipped (document already signed)';
      }
      await generateDocument({ organizationId: inst.organization_id, userId: job.payload.userId ?? inst.started_by }, job.payload.instanceId, job.payload.docKey);
      return 'generated';
    }
    case 'email_users': {
      const users = await query(pool, `select email from app_user where id = any($1::uuid[]) and active`, [job.payload.userIds]);
      const link = job.payload.instanceId ? `\n\n${config.publicUrl}/dosare/${job.payload.instanceId}` : '';
      return sendMail(users.map((u) => u.email), `[Flux AM] ${job.payload.subject}`, `${job.payload.body}${link}`);
    }
    case 'email_beneficiary': {
      const inst = await maybeOne(pool, `select i.title, i.organization_id from instance i where i.id = $1`, [job.payload.instanceId]);
      if (!inst) return 'skipped';
      const recipient = await maybeOne(
        pool,
        `select coalesce(c.email, '') as email from register_entry e join correspondent c on c.id = coalesce(e.recipient_id, e.sender_id)
          where e.instance_id = $1 and c.email is not null order by e.registered_at desc limit 1`,
        [job.payload.instanceId],
      );
      const attachments = [];
      for (const key of job.payload.attach ?? []) {
        const doc = await maybeOne(pool, `select id from document where instance_id = $1 and doc_key = $2`, [job.payload.instanceId, key]);
        const v = doc ? await latestVersion(pool, doc.id) : null;
        if (v) attachments.push({ filename: v.file_name, content: (await readVersion(pool, v.id)).content });
      }
      return sendMail(recipient?.email ? [recipient.email] : [], inst.title, `Vă transmitem atașat documentele privind: ${inst.title}.`, attachments);
    }
    case 'call_rest': {
      const res = await fetch(job.payload.url, { method: job.payload.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instanceId: job.payload.instanceId }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${res.status}`;
    }
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

/** Runs due outbox jobs once. Failed jobs are retried with backoff, up to 5 attempts. */
export async function processOutboxOnce(limit = 20): Promise<number> {
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const done = await tx(async (db) => {
      const job = await maybeOne<Job>(
        db,
        `select id, kind, payload, attempts from job_outbox
          where dispatched_at is null and run_after <= now() and attempts < 5
          order by id for update skip locked limit 1`,
      );
      if (!job) return false;
      try {
        const result = await run(job);
        await query(db, `update job_outbox set dispatched_at = now(), attempts = attempts + 1, last_error = $2 where id = $1`, [job.id, result === 'sent' || result === 'generated' ? null : result]);
      } catch (err) {
        await query(db, `update job_outbox set attempts = attempts + 1, last_error = $2, run_after = now() + make_interval(mins => power(2, attempts)::int) where id = $1`, [
          job.id,
          (err as Error).message,
        ]);
      }
      return true;
    });
    if (!done) break;
    processed++;
  }
  return processed;
}

export async function runDeadlineScan() {
  return scanDeadlines(getPool());
}
