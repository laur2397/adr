import type { FastifyInstance } from 'fastify';
import { userOf } from '../../app.js';
import { getPool, maybeOne, query, tx } from '../../core/db.js';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { getFile } from '../../documents/storage.js';
import { hasRole, type CurrentUser } from '../../identity/context.js';
import { processMail, storeIncomingMail, type MailAction } from './intake.js';

const canUse = (u: CurrentUser) => hasRole(u, 'registry_inspector', 'functional_admin');

export async function mailRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>('/mail', async (req) => {
    const user = userOf(req);
    if (!canUse(user)) throw forbidden('Corespondența electronică este gestionată de registratură.');
    return {
      items: await query(
        getPool(),
        `select m.id, m.from_address, m.from_name, m.subject, m.received_at, m.status, m.error, jsonb_array_length(m.attachments) as attachments,
                m.suggested_instance_id, si.title as suggested_title, si.reference_no as suggested_reference, m.instance_id, e.number_display, m.processed_at,
                u.full_name as processed_by_name
           from mail_message m left join instance si on si.id = m.suggested_instance_id left join register_entry e on e.id = m.register_entry_id
           left join app_user u on u.id = m.processed_by
          where m.organization_id = $1 and ($2::text is null or m.status = $2)
          order by m.received_at desc limit 200`,
        [user.organizationId, req.query.status || null],
      ),
    };
  });

  app.get<{ Params: { id: string } }>('/mail/:id', async (req) => {
    const user = userOf(req);
    if (!canUse(user)) throw forbidden();
    const m = await maybeOne(getPool(), `select * from mail_message where id = $1 and organization_id = $2`, [req.params.id, user.organizationId]);
    if (!m) throw notFound('Mesajul');
    return m;
  });

  /** index -1 = the original .eml, otherwise the attachment at that position. */
  app.get<{ Params: { id: string; index: string } }>('/mail/:id/files/:index', async (req, reply) => {
    const user = userOf(req);
    if (!canUse(user)) throw forbidden();
    const m = await maybeOne(getPool(), `select raw_storage_key, attachments from mail_message where id = $1 and organization_id = $2`, [req.params.id, user.organizationId]);
    if (!m) throw notFound('Mesajul');
    const i = Number(req.params.index);
    const file = i < 0 ? { storageKey: m.raw_storage_key, fileName: 'mesaj.eml', mimeType: 'message/rfc822' } : m.attachments[i];
    if (!file) throw notFound('Fișierul');
    reply.header('content-type', file.mimeType);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    return reply.send(await getFile(file.storageKey));
  });

  /** Manual import of .eml files (drag and drop from the mail client). */
  app.post('/mail/upload', async (req, reply) => {
    const user = userOf(req);
    if (!canUse(user)) throw forbidden();
    const file = await req.file();
    if (!file) throw badRequest('Alegeți fișierul .eml.');
    const content = await file.toBuffer();
    const r = await tx((db) => storeIncomingMail(db, user.organizationId, content));
    reply.status(r.duplicate ? 200 : 201);
    return r;
  });

  app.post<{ Params: { id: string }; Body: MailAction }>('/mail/:id/process', async (req) => {
    const user = userOf(req);
    if (!canUse(user)) throw forbidden();
    if (!['register', 'attach', 'ignore'].includes(req.body?.action)) throw badRequest('Alegeți ce faceți cu mesajul.');
    return processMail(user, req.params.id, req.body);
  });
}
