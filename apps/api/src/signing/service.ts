import { audit } from '../audit/audit.js';
import { getPool, maybeOne, one, query, tx } from '../core/db.js';
import { AppError, conflict, forbidden, notFound } from '../core/errors.js';
import type { AuditActor } from '../audit/audit.js';
import { addVersion, generateDocument, latestVersion, readVersion } from '../documents/service.js';
import { actorOf, type CurrentUser } from '../identity/context.js';
import { notifyUsers } from '../notifications/service.js';
import { loadInstance } from '../workflow/load.js';
import { actingAs, openTasks } from '../workflow/tasks.js';
import { signatureProvider, type SignatureLevel } from './providers.js';

const ROLE_LABEL: Record<string, string> = {
  evf_check: 'Expert verificare financiară',
  ei_check: 'Expert implementare',
  head_review: 'Șef serviciu',
  cfpp: 'Control financiar preventiv',
  director_approval: 'Director',
};

async function dataChangedSince(instanceId: string, since: string): Promise<boolean> {
  const row = await maybeOne(
    getPool(),
    `select greatest(
       (select max(updated_at) from instance_field where instance_id = $1 and source <> 'calculated'),
       (select max(updated_at) from instance_list_row where instance_id = $1),
       (select max(answered_at) from checklist_response where instance_id = $1)) > $2 as changed`,
    [instanceId, since],
  );
  return Boolean(row?.changed);
}

/**
 * Starts signing the latest version of a process document. Allowed only for a user who has an
 * open task at a step where a path requires this document to be signed.
 */
export async function signDocument(user: CurrentUser, instanceId: string, docKey: string) {
  const pool = getPool();
  const ctx = await loadInstance(pool, instanceId);
  const spec = ctx.def.documents?.find((d) => d.key === docKey);
  if (!spec) throw notFound(`Documentul „${docKey}”`);
  const tasks = await openTasks(pool, instanceId);
  const task = tasks.find((t) => {
    const step = ctx.def.steps.find((s) => s.key === t.step_key);
    return step?.paths?.some((p) => p.requiresSignatures?.includes(docKey)) && actingAs(user, t, ctx.def.key).ok;
  });
  if (!task) throw forbidden('Nu aveți de semnat acest document la pasul curent al dosarului.');

  // Sign what the dossier says now: generate the document if missing, regenerate it if the data
  // changed after the last version (which also invalidates signatures given on the old one).
  let doc = await maybeOne(pool, `select id, title from document where instance_id = $1 and doc_key = $2`, [instanceId, docKey]);
  let current = doc ? await latestVersion(pool, doc.id) : null;
  if (!doc || !current || (await dataChangedSince(instanceId, current.created_at))) {
    await generateDocument(actorOf(user) as AuditActor & { userId: string }, instanceId, docKey);
    doc = await maybeOne(pool, `select id, title from document where instance_id = $1 and doc_key = $2`, [instanceId, docKey]);
    if (!doc) throw new AppError(500, 'Documentul nu a putut fi generat.');
    current = await latestVersion(pool, doc.id);
  }
  const version = current;
  if (!version || version.mime_type !== 'application/pdf') {
    throw new AppError(422, 'Se pot semna doar documente PDF. Conversia în PDF nu este disponibilă pe acest server; contactați administratorul IT.');
  }
  const already = await maybeOne(pool, `select id from signature where document_id = $1 and signer_user_id = $2 and status = 'signed'`, [doc.id, user.id]);
  if (already) throw conflict('Ați semnat deja versiunea curentă a acestui document.');

  const level = (spec.signatureLevel ?? 'qualified') as SignatureLevel;
  const provider = signatureProvider();
  const signature = await tx(async (db) => {
    const { seq } = await one(db, `select count(*)::int + 1 as seq from signature where document_id = $1 and status = 'signed'`, [doc.id]);
    const row = await one(
      db,
      `insert into signature (document_version_id, document_id, instance_id, step_key, sequence, signer_user_id, signer_role, level, status, provider)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) returning id, sequence`,
      [version.id, doc.id, instanceId, task.step_key, seq, user.id, ROLE_LABEL[task.step_key] ?? task.name, level, provider.name],
    );
    await audit(db, actorOf(user), { action: 'signature.request', entityType: 'signature', entityId: row.id, newValue: { docKey, versionNo: version.version_no, level } });
    return row;
  });

  const { content } = await readVersion(pool, version.id);
  const result = await provider.sign({
    signatureId: signature.id,
    pdf: content,
    fileName: version.file_name,
    signer: { name: user.fullName, email: user.email, role: ROLE_LABEL[task.step_key] ?? task.name },
    level,
    reason: `${doc.title} – ${ctx.instance.title}`,
    sequence: signature.sequence,
  });
  if (result.status === 'pending') {
    await query(pool, `update signature set provider_reference = $2 where id = $1`, [signature.id, result.providerReference]);
    return { signatureId: signature.id, status: 'pending', redirectUrl: result.redirectUrl ?? null, instructions: result.instructions ?? null };
  }
  await completeSignature(signature.id, result.signedPdf, result.providerReference, result.format, result.validation);
  return { signatureId: signature.id, status: 'signed' };
}

/** Stores the signed PDF as a new version, provided the document did not change meanwhile. */
export async function completeSignature(
  signatureId: string,
  signedPdf: Buffer,
  providerReference: string,
  format: string | null,
  validation: Record<string, unknown>,
) {
  return tx(async (db) => {
    const sig = await maybeOne(
      db,
      `select s.*, d.organization_id, d.title from signature s join document d on d.id = s.document_id where s.id = $1 for update of s`,
      [signatureId],
    );
    if (!sig) throw notFound('Semnătura');
    if (sig.status !== 'pending') throw conflict('Semnătura nu mai este în așteptare.');
    const latest = await latestVersion(db, sig.document_id);
    if (!latest || latest.id !== sig.document_version_id) {
      await query(db, `update signature set status = 'invalidated', invalidated_at = now(), invalidated_reason = $2 where id = $1`, [
        signatureId,
        'Documentul s-a modificat în timpul semnării.',
      ]);
      throw conflict('Documentul s-a modificat în timpul semnării. Semnați din nou versiunea curentă.');
    }
    const version = await addVersion(db, {
      documentId: sig.document_id,
      content: signedPdf,
      fileName: latest.file_name,
      mimeType: 'application/pdf',
      source: 'generated',
      archivalMetadata: { signedBy: sig.signer_user_id, signatureId, previousVersion: latest.version_no },
      createdBy: sig.signer_user_id,
    });
    await query(
      db,
      `update signature set status = 'signed', signed_at = now(), signed_version_id = $2, provider_reference = $3, format = $4, validation_result = $5
        where id = $1`,
      [signatureId, version.id, providerReference, format, JSON.stringify(validation)],
    );
    await audit(db, { organizationId: sig.organization_id, userId: sig.signer_user_id }, {
      action: 'signature.complete',
      entityType: 'signature',
      entityId: signatureId,
      newValue: { document: sig.title, versionNo: version.version_no, sha256: version.sha256.toString('hex'), format, provider: sig.provider },
    });
    return { versionId: version.id };
  });
}

/** "Documente de semnat": documents the user must sign at their open tasks. */
export async function pendingForUser(user: CurrentUser) {
  const pool = getPool();
  const rows = await query(
    pool,
    `select t.*, i.title as instance_title, i.reference_no, d.definition
       from task t join instance i on i.id = t.instance_id join process_definition d on d.id = i.definition_id
      where t.status = 'open' and i.organization_id = $1`,
    [user.organizationId],
  );
  const out: Array<Record<string, unknown>> = [];
  for (const t of rows) {
    if (!actingAs(user, t as never, t.definition.key).ok) continue;
    const step = t.definition.steps.find((s: { key: string }) => s.key === t.step_key);
    const keys = new Set<string>((step?.paths ?? []).flatMap((p: { requiresSignatures?: string[] }) => p.requiresSignatures ?? []));
    for (const docKey of keys) {
      const doc = await maybeOne(pool, `select id, title from document where instance_id = $1 and doc_key = $2`, [t.instance_id, docKey]);
      const signed = doc
        ? await maybeOne(pool, `select 1 from signature where document_id = $1 and signer_user_id = $2 and status = 'signed'`, [doc.id, user.id])
        : null;
      if (!signed) {
        out.push({
          instanceId: t.instance_id,
          instanceTitle: t.instance_title,
          referenceNo: t.reference_no,
          taskId: t.id,
          stepName: t.name,
          docKey,
          documentTitle: doc?.title ?? docKey,
          generated: Boolean(doc),
        });
      }
    }
  }
  return out;
}

export async function notifySigners(instanceId: string, userIds: string[], title: string) {
  await notifyUsers(getPool(), userIds, { kind: 'signature_requested', instanceId, title });
}
