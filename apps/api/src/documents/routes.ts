import type { FastifyInstance } from 'fastify';
import { requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, one, query, tx } from '../core/db.js';
import { badRequest, forbidden, notFound, unprocessable } from '../core/errors.js';
import { actorOf } from '../identity/context.js';
import { looksSigned, validatePdfSignatures } from '../signing/providers.js';
import { loadInstance } from '../workflow/load.js';
import { actingAs, openTasks } from '../workflow/tasks.js';
import { addVersion, documentsForInstance, generateDocument, readVersion } from './service.js';
import { getFile } from './storage.js';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword',
  'application/vnd.ms-excel',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'application/xml',
  'text/xml',
  'application/zip',
]);

const contentDisposition = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export async function documentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/instances/:id/documents', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    const ctx = await loadInstance(getPool(), req.params.id);
    return { items: await documentsForInstance(getPool(), req.params.id, ctx.def) };
  });

  app.post<{ Params: { id: string; docKey: string } }>('/instances/:id/documents/:docKey/generate', async (req) => {
    const user = userOf(req);
    const pool = getPool();
    if ((await requireView(pool, user, req.params.id)) !== 'edit') throw forbidden();
    const ctx = await loadInstance(pool, req.params.id);
    if (ctx.instance.status !== 'active') throw unprocessable('Dosarul este închis; documentele nu mai pot fi regenerate.');
    const tasks = await openTasks(pool, req.params.id);
    if (!tasks.some((t) => actingAs(user, t, ctx.def.key).ok)) throw forbidden('Puteți genera documente doar când aveți o sarcină deschisă în dosar.');
    return generateDocument(actorOf(user) as never, req.params.id, req.params.docKey);
  });

  /** Upload of a supporting document (multipart: file + docType + title). Signed PDFs are validated. */
  app.post<{ Params: { id: string } }>('/instances/:id/documents', async (req, reply) => {
    const user = userOf(req);
    const pool = getPool();
    if ((await requireView(pool, user, req.params.id)) !== 'edit') throw forbidden();
    const ctx = await loadInstance(pool, req.params.id);
    if (ctx.instance.status !== 'active') throw unprocessable('Dosarul este închis.');
    const file = await req.file();
    if (!file) throw badRequest('Alegeți un fișier.');
    const content = await file.toBuffer();
    if (!ALLOWED_MIME.has(file.mimetype)) throw badRequest(`Tipul de fișier ${file.mimetype} nu este acceptat. Încărcați PDF, Word, Excel, imagini sau XML.`);
    const field = (name: string) => {
      const f = file.fields[name] as { value?: unknown } | undefined;
      return typeof f?.value === 'string' ? f.value : undefined;
    };
    const docType = field('docType') ?? 'supporting';
    const title = field('title') ?? file.filename;
    const validation = file.mimetype === 'application/pdf' && looksSigned(content) ? await validatePdfSignatures(content, file.filename) : null;
    const result = await tx(async (db) => {
      const doc = await one(
        db,
        `insert into document (organization_id, instance_id, doc_type, title, created_by) values ($1, $2, $3, $4, $5) returning id`,
        [user.organizationId, req.params.id, docType, title, user.id],
      );
      const v = await addVersion(db, { documentId: doc.id, content, fileName: file.filename, mimeType: file.mimetype, source: 'uploaded', createdBy: user.id });
      if (validation) {
        await query(
          db,
          `insert into signature (document_version_id, document_id, instance_id, sequence, level, status, validation_result, signed_version_id)
           values ($1, $2, $3, 1, 'qualified', 'external', $4, $1)`,
          [v.id, doc.id, req.params.id, JSON.stringify(validation)],
        );
      }
      await audit(db, actorOf(user), {
        action: 'document.upload',
        entityType: 'document',
        entityId: doc.id,
        newValue: { title, docType, fileName: file.filename, sha256: v.sha256.toString('hex'), signatureValidation: validation?.result ?? null },
      });
      return { documentId: doc.id, versionId: v.id, signatureValidation: validation };
    });
    reply.status(201);
    return result;
  });

  app.get<{ Params: { versionId: string }; Querystring: { format?: string; inline?: string } }>('/documents/versions/:versionId/content', async (req, reply) => {
    const user = userOf(req);
    const pool = getPool();
    const { row, content } = await readVersion(pool, req.params.versionId);
    if (row.organization_id !== user.organizationId) throw notFound('Documentul');
    if (row.instance_id) await requireView(pool, user, row.instance_id);
    let body = content;
    let name = row.file_name as string;
    let mime = row.mime_type as string;
    if (req.query.format === 'docx') {
      const docx = row.archival_metadata?.docx;
      if (!docx) throw notFound('Varianta DOCX');
      body = await getFile(docx.storageKey);
      name = name.replace(/\.pdf$/i, '.docx');
      mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    await audit(pool, actorOf(user), { action: 'document.view', entityType: 'document', entityId: row.document_id, newValue: { versionNo: row.version_no, format: req.query.format ?? 'original' } });
    reply.header('content-type', mime);
    reply.header('content-disposition', req.query.inline ? `inline; filename*=UTF-8''${encodeURIComponent(name)}` : contentDisposition(name));
    reply.header('x-content-sha256', Buffer.from(row.sha256).toString('hex'));
    return reply.send(body);
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (req) => {
    const user = userOf(req);
    const doc = await maybeOne(getPool(), `select * from document where id = $1 and organization_id = $2`, [req.params.id, user.organizationId]);
    if (!doc) throw notFound('Documentul');
    if (doc.instance_id) await requireView(getPool(), user, doc.instance_id);
    return doc;
  });
}
