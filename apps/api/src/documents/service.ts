import type { FieldDef, ProcessDefinition } from '@flux/process-schema';
import { formatAmount, formatDate } from '@flux/validators';
import { audit, type AuditActor } from '../audit/audit.js';
import { today } from '../core/config.js';
import { getPool, maybeOne, one, query, tx, type Db } from '../core/db.js';
import { AppError, notFound } from '../core/errors.js';
import { loadFields } from '../forms/store.js';
import { entriesForInstance } from '../registry/service.js';
import { invalidateDocumentSignatures } from '../signing/invalidate.js';
import { appendEvidenceAnnex, listEvidence } from '../visits/evidence.js';
import { loadInstance, type InstanceContext } from '../workflow/load.js';
import { docxToPdf, pdfConversionAvailable, renderDocx } from './render.js';
import { getFile, putFile } from './storage.js';

export interface NewVersion {
  documentId: string;
  content: Buffer;
  fileName: string;
  mimeType: string;
  source: 'generated' | 'uploaded' | 'email' | 'scanned';
  templateId?: string | null;
  archivalMetadata?: Record<string, unknown>;
  createdBy: string;
}

export async function addVersion(db: Db, v: NewVersion) {
  const stored = await putFile(v.content);
  const { next } = await one(db, `select coalesce(max(version_no), 0) + 1 as next from document_version where document_id = $1`, [v.documentId]);
  return one(
    db,
    `insert into document_version (document_id, version_no, storage_key, file_name, mime_type, size_bytes, sha256, source, template_id, archival_metadata, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, version_no, sha256`,
    [v.documentId, next, stored.storageKey, v.fileName, v.mimeType, stored.size, stored.sha256, v.source, v.templateId ?? null, JSON.stringify(v.archivalMetadata ?? {}), v.createdBy],
  );
}

export async function latestVersion(db: Db, documentId: string) {
  return maybeOne(
    db,
    `select v.* from document_version v where v.document_id = $1 order by v.version_no desc limit 1`,
    [documentId],
  );
}

export async function readVersion(db: Db, versionId: string): Promise<{ row: Record<string, any>; content: Buffer }> {
  const row = await maybeOne(db, `select v.*, d.instance_id, d.organization_id from document_version v join document d on d.id = v.document_id where v.id = $1`, [versionId]);
  if (!row) throw notFound('Documentul');
  return { row, content: await getFile(row.storage_key) };
}

async function ensureDocument(db: Db, ctx: InstanceContext, docKey: string, userId: string) {
  const spec = ctx.def.documents?.find((d) => d.key === docKey);
  if (!spec) throw notFound(`Documentul „${docKey}”`);
  const existing = await maybeOne(db, `select id from document where instance_id = $1 and doc_key = $2`, [ctx.instance.id, docKey]);
  if (existing) return { id: existing.id as string, spec };
  const title = await maybeOne(db, `select name from document_template where organization_id = $1 and key = $2 order by version desc limit 1`, [
    ctx.instance.organization_id,
    spec.template,
  ]);
  const row = await one(
    db,
    `insert into document (organization_id, instance_id, doc_type, doc_key, title, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
    [ctx.instance.organization_id, ctx.instance.id, spec.docType, docKey, title?.name ?? docKey, userId],
  );
  return { id: row.id as string, spec };
}

function formatValue(field: { type: string; resultType?: string }, value: unknown): unknown {
  if (value === null || value === undefined) return '';
  const type = field.type === 'calculated' ? (field.resultType ?? 'text') : field.type;
  if (type === 'amount' && (typeof value === 'string' || typeof value === 'number')) return formatAmount(String(value));
  if (type === 'date' && typeof value === 'string') return formatDate(value);
  if (type === 'boolean') return value ? 'Da' : 'Nu';
  return value;
}

/** Data exposed to DOCX templates: raw values under `raw`, display values at the top level. */
export async function templateData(db: Db, ctx: InstanceContext): Promise<Record<string, unknown>> {
  const { values } = await loadFields(db, ctx.instance.id);
  const labels = await query(
    db,
    `select n.key, i.code, i.label from nomenclature n join nomenclature_item i on i.nomenclature_id = n.id where n.organization_id = $1`,
    [ctx.instance.organization_id],
  );
  const label = (nomenclature: string | undefined, code: unknown) =>
    labels.find((l) => l.key === nomenclature && l.code === code)?.label ?? code;
  const display: Record<string, unknown> = {};
  for (const f of ctx.def.fields as FieldDef[]) {
    const v = values[f.key];
    if (f.type === 'choice') {
      display[f.key] = v ? label(f.nomenclature, v) : '';
    } else if (f.type === 'line_items') {
      display[f.key] = ((v as Record<string, unknown>[] | undefined) ?? []).map((row, i) => {
        const r: Record<string, unknown> = { nr: i + 1 };
        for (const c of f.columns ?? []) r[c.key] = formatValue(c, row[c.key]);
        return r;
      });
    } else {
      display[f.key] = formatValue(f, v);
    }
  }
  const people = await query(
    db,
    `select distinct on (t.step_key) t.step_key, u.full_name, u.job_title, t.completed_at
       from task t join app_user u on u.id = t.completed_by
      where t.instance_id = $1 and t.status = 'completed' order by t.step_key, t.completed_at desc`,
    [ctx.instance.id],
  );
  // A step still in progress is signed by whoever holds it now (e.g. the inspector drafting the report).
  const holders = await query(
    db,
    `select t.step_key, u.full_name, u.job_title from task t join app_user u on u.id = t.assignee_user_id
      where t.instance_id = $1 and t.status = 'open'`,
    [ctx.instance.id],
  );
  for (const h of holders) if (!people.some((p) => p.step_key === h.step_key)) people.push(h);
  const checklist = await query(
    db,
    `select ci.position, ci.code, ci.question, ci.legal_basis, r.answer, r.observation, r.verifier_role
       from instance_checklist ic join checklist_item ci on ci.template_id = ic.template_id
       left join checklist_response r on r.instance_id = ic.instance_id and r.item_id = ci.id
      where ic.instance_id = $1 order by ic.checklist_key, ci.position, r.verifier_role`,
    [ctx.instance.id],
  );
  const registrations = await entriesForInstance(db, ctx.instance.id);
  const organization = await maybeOne(db, `select name, cui from organization where id = $1`, [ctx.instance.organization_id]);
  return {
    ...display,
    organization,
    raw: values,
    today: formatDate(today()),
    instance: { title: ctx.instance.title, reference_no: ctx.instance.reference_no ?? '' },
    project: ctx.project
      ? {
          ...ctx.project,
          eligible_value: ctx.project.eligible_value ? formatAmount(ctx.project.eligible_value) : '',
          total_value: ctx.project.total_value ? formatAmount(ctx.project.total_value) : '',
          contract_date: ctx.project.contract_date ? formatDate(ctx.project.contract_date) : '',
        }
      : {},
    beneficiary: ctx.beneficiary ?? {},
    people: Object.fromEntries(people.map((p) => [p.step_key, { name: p.full_name, job_title: p.job_title ?? '' }])),
    checklist: checklist
      .filter((c) => c.verifier_role === 'primary' || c.verifier_role === null)
      .map((c) => ({ ...c, answer: c.answer ?? '', observation: c.observation ?? '', legal_basis: c.legal_basis ?? '' })),
    registrations: registrations.map((r) => ({ ...r, registered_at: formatDate(new Date(r.registered_at).toISOString().slice(0, 10)) })),
    registration_in: registrations.find((r) => r.direction === 'in')?.number_display ?? '',
  };
}

/**
 * (Re)generates a process document from its template: DOCX, then PDF when LibreOffice is
 * available. Rendering happens outside the transaction; the new version and the invalidation of
 * signatures on the previous version are committed together.
 */
export async function generateDocument(actor: AuditActor & { userId: string }, instanceId: string, docKey: string) {
  const pool = getPool();
  const ctx = await loadInstance(pool, instanceId);
  const spec = ctx.def.documents?.find((d) => d.key === docKey);
  if (!spec) throw notFound(`Documentul „${docKey}”`);
  const tpl = await maybeOne(
    pool,
    `select id, storage_key, name, version from document_template where organization_id = $1 and key = $2 and status = 'published'`,
    [ctx.instance.organization_id, spec.template],
  );
  if (!tpl) throw new AppError(422, `Șablonul „${spec.template}” nu este publicat. Contactați administratorul funcțional.`);
  const data = await templateData(pool, ctx);
  let docx: Buffer;
  try {
    docx = renderDocx(await getFile(tpl.storage_key), data);
  } catch (err) {
    throw new AppError(422, `Șablonul „${tpl.name}” nu a putut fi completat: ${(err as Error).message}`);
  }
  if (spec.appendEvidence) docx = await appendEvidenceAnnex(docx, await listEvidence(pool, ctx.instance.id));
  const wantPdf = spec.pdf !== false && (await pdfConversionAvailable());
  const pdf = wantPdf ? await docxToPdf(docx) : null;
  const baseName = `${tpl.name}${ctx.instance.reference_no ? ` ${ctx.instance.reference_no.replace(/[/\\]/g, '-')}` : ''}`;

  return tx(async (db) => {
    const doc = await ensureDocument(db, ctx, docKey, actor.userId);
    const docxStored = await putFile(docx);
    const version = await addVersion(db, {
      documentId: doc.id,
      content: pdf ?? docx,
      fileName: `${baseName}.${pdf ? 'pdf' : 'docx'}`,
      mimeType: pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      source: 'generated',
      templateId: tpl.id,
      archivalMetadata: {
        template: `${spec.template} v${tpl.version}`,
        docx: { storageKey: docxStored.storageKey, sha256: docxStored.sha256.toString('hex') },
      },
      createdBy: actor.userId,
    });
    const invalidated = await invalidateDocumentSignatures(db, actor, doc.id, 'Documentul a fost regenerat după semnare; este necesară o nouă semnătură.');
    await audit(db, actor, {
      action: 'document.generate',
      entityType: 'document',
      entityId: doc.id,
      newValue: { docKey, version: version.version_no, sha256: version.sha256.toString('hex'), invalidatedSignatures: invalidated },
    });
    return { documentId: doc.id, versionId: version.id as string, versionNo: version.version_no as number, pdf: Boolean(pdf), invalidatedSignatures: invalidated };
  });
}

export async function documentsForInstance(db: Db, instanceId: string, def: ProcessDefinition) {
  const docs = await query(
    db,
    `select d.id, d.doc_key, d.doc_type, d.title, d.created_at from document d where d.instance_id = $1 order by d.created_at`,
    [instanceId],
  );
  const versions = await query(
    db,
    `select v.id, v.document_id, v.version_no, v.file_name, v.mime_type, v.size_bytes, encode(v.sha256, 'hex') as sha256, v.source, v.created_at,
            u.full_name as created_by_name
       from document_version v join document d on d.id = v.document_id join app_user u on u.id = v.created_by
      where d.instance_id = $1 order by v.document_id, v.version_no desc`,
    [instanceId],
  );
  const signatures = await query(
    db,
    `select s.id, s.document_id, s.document_version_id, s.signed_version_id, s.status, s.level, s.provider, s.format, s.signed_at,
            s.invalidated_reason, s.signer_role, s.step_key, u.full_name as signer_name, s.signer_user_id, s.validation_result
       from signature s left join app_user u on u.id = s.signer_user_id
      where s.instance_id = $1 order by s.created_at`,
    [instanceId],
  );
  return docs.map((d) => ({
    id: d.id,
    key: d.doc_key,
    type: d.doc_type,
    title: d.title,
    signatureLevel: def.documents?.find((x) => x.key === d.doc_key)?.signatureLevel ?? null,
    versions: versions.filter((v) => v.document_id === d.id),
    signatures: signatures.filter((s) => s.document_id === d.id),
  }));
}
