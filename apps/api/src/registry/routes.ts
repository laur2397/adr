import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, query, tx } from '../core/db.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';
import { startInstance } from '../workflow/engine.js';
import { createEntry, upsertCorrespondent, type CorrespondentInput } from './service.js';

const READERS = ['registry_inspector', 'functional_admin', 'head_of_unit', 'director', 'auditor'];
const WRITERS = ['registry_inspector', 'functional_admin'];

function requireReader(user: CurrentUser) {
  if (!hasRole(user, ...READERS)) throw forbidden('Registrele sunt disponibile registraturii, conducerii și auditorilor.');
}

const DIRECTION_LABEL: Record<string, string> = { in: 'Intrare', out: 'Ieșire', internal: 'Intern' };

export async function registryRoutes(app: FastifyInstance) {
  app.get('/registers', async (req) => {
    const user = userOf(req);
    requireReader(user);
    return {
      items: await query(
        getPool(),
        `select r.key, r.name, r.number_format, r.yearly_reset,
                (select last_value from register_counter c where c.register_id = r.id and c.year = extract(year from current_date)::int) as last_number
           from register r where r.organization_id = $1 and r.active order by r.name`,
        [user.organizationId],
      ),
    };
  });

  app.get<{ Params: { key: string }; Querystring: { year?: string; q?: string; direction?: string; from?: string; to?: string; format?: string; limit?: string } }>(
    '/registers/:key/entries',
    async (req, reply) => {
      const user = userOf(req);
      requireReader(user);
      const reg = await maybeOne(getPool(), `select id, name from register where organization_id = $1 and key = $2`, [user.organizationId, req.params.key]);
      if (!reg) throw notFound('Registrul');
      const params: unknown[] = [reg.id];
      const where = ['e.register_id = $1'];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (req.query.year) add('e.year = ?', Number(req.query.year));
      if (req.query.direction) add('e.direction = ?', req.query.direction);
      if (req.query.from) add('e.registered_at >= ?::date', req.query.from);
      if (req.query.to) add(`e.registered_at < ?::date + 1`, req.query.to);
      if (req.query.q) add(`(e.search_vector @@ websearch_to_tsquery('flux.ro', ?) or e.number_display ilike ? || '%' or s.name ilike '%' || ? || '%' or rc.name ilike '%' || ? || '%')`, req.query.q);
      const limit = Math.min(Number(req.query.limit ?? 200), 5000);
      const rows = await query(
        getPool(),
        `select e.id, e.number, e.number_display, e.registered_at, e.direction, e.subject, e.channel, e.resolution, e.instance_id,
                s.name as sender, rc.name as recipient, dep.name as department, rel.number_display as related_number,
                af.year as archive_year, an.indicative as archive_indicative, u.full_name as registered_by
           from register_entry e
           left join correspondent s on s.id = e.sender_id left join correspondent rc on rc.id = e.recipient_id
           left join department dep on dep.id = e.internal_department_id left join register_entry rel on rel.id = e.related_entry_id
           left join archive_file af on af.id = e.archive_file_id left join archive_nomenclature_item an on an.id = af.nomenclature_item_id
           join app_user u on u.id = e.created_by
          where ${where.join(' and ')}
          order by e.year desc, e.number desc limit ${limit}`,
        params,
      );
      if (req.query.format === 'xlsx') {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(reg.name.slice(0, 31));
        ws.columns = [
          { header: 'Număr', key: 'number_display', width: 18 },
          { header: 'Data', key: 'date', width: 12 },
          { header: 'Tip', key: 'direction', width: 10 },
          { header: 'Emitent', key: 'sender', width: 30 },
          { header: 'Destinatar', key: 'recipient', width: 30 },
          { header: 'Conținut pe scurt', key: 'subject', width: 60 },
          { header: 'Rezoluție', key: 'resolution', width: 30 },
          { header: 'Conexat cu', key: 'related_number', width: 18 },
          { header: 'Dosar arhivă', key: 'archive', width: 14 },
          { header: 'Înregistrat de', key: 'registered_by', width: 24 },
        ];
        ws.getRow(1).font = { bold: true };
        for (const r of rows) {
          ws.addRow({
            ...r,
            date: new Date(r.registered_at).toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest' }),
            direction: DIRECTION_LABEL[r.direction],
            archive: r.archive_indicative ? `${r.archive_indicative}/${r.archive_year}` : '',
          });
        }
        await audit(getPool(), actorOf(user), { action: 'register.export', entityType: 'register', entityId: reg.id, newValue: { rows: rows.length } });
        reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        reply.header('content-disposition', `attachment; filename="registru-${req.params.key}.xlsx"`);
        return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
      }
      return { items: rows.map((r) => ({ ...r, direction_label: DIRECTION_LABEL[r.direction] })) };
    },
  );

  app.post<{
    Params: { key: string };
    Body: {
      direction: 'in' | 'out' | 'internal';
      subject: string;
      sender?: CorrespondentInput;
      recipient?: CorrespondentInput;
      channel?: string;
      internalDepartmentId?: string;
      relatedEntryId?: string;
      archiveFileId?: string;
      /** Optionally start a process for the registered document (e.g. general correspondence P5). */
      startProcess?: { definitionKey: string; projectId?: string; beneficiaryId?: string; fields?: Record<string, unknown> };
    };
  }>('/registers/:key/entries', async (req, reply) => {
    const user = userOf(req);
    if (!hasRole(user, ...WRITERS)) throw forbidden('Doar registratura poate înregistra documente.');
    const b = req.body;
    if (!b?.subject?.trim()) throw badRequest('Completați conținutul pe scurt.', [{ field: 'subject', message: 'Obligatoriu' }]);
    if (!['in', 'out', 'internal'].includes(b.direction)) throw badRequest('Alegeți tipul înregistrării (intrare, ieșire, intern).');
    if (b.direction === 'in' && !b.sender?.name) throw badRequest('Completați emitentul.', [{ field: 'sender', message: 'Obligatoriu' }]);
    if (b.direction === 'out' && !b.recipient?.name) throw badRequest('Completați destinatarul.', [{ field: 'recipient', message: 'Obligatoriu' }]);
    const result = await tx(async (db) => {
      const senderId = b.sender?.name ? await upsertCorrespondent(db, user.organizationId, b.sender) : null;
      const recipientId = b.recipient?.name ? await upsertCorrespondent(db, user.organizationId, b.recipient) : null;
      let instanceId: string | null = null;
      if (b.startProcess) {
        instanceId = await startInstance(db, user, {
          ...b.startProcess,
          title: b.subject,
          fields: { ...(b.startProcess.fields ?? {}), subject: b.subject, sender_name: b.sender?.name ?? null, channel: b.channel ?? null },
        });
      }
      const entry = await createEntry(db, actorOf(user) as never, {
        registerKey: req.params.key,
        direction: b.direction,
        subject: b.subject.trim(),
        senderId,
        recipientId,
        channel: b.channel ?? 'desk',
        internalDepartmentId: b.internalDepartmentId ?? null,
        relatedEntryId: b.relatedEntryId ?? null,
        archiveFileId: b.archiveFileId ?? null,
        instanceId,
      });
      if (instanceId) {
        await query(db, `update instance set reference_no = $2 where id = $1 and reference_no is null`, [instanceId, entry.number_display]);
      }
      return { ...entry, instanceId };
    });
    reply.status(201);
    return result;
  });

  app.patch<{ Params: { key: string; id: string }; Body: { resolution?: string; internalDepartmentId?: string; relatedEntryId?: string; archiveFileId?: string } }>(
    '/registers/:key/entries/:id',
    async (req) => {
      const user = userOf(req);
      if (!hasRole(user, ...WRITERS, 'head_of_unit', 'director')) throw forbidden();
      return tx(async (db) => {
        const old = await maybeOne(
          db,
          `select e.* from register_entry e join register r on r.id = e.register_id where e.id = $1 and r.key = $2 and r.organization_id = $3 for update of e`,
          [req.params.id, req.params.key, user.organizationId],
        );
        if (!old) throw notFound('Înregistrarea');
        const b = req.body ?? {};
        const updated = await maybeOne(
          db,
          `update register_entry set resolution = coalesce($2, resolution), internal_department_id = coalesce($3, internal_department_id),
                  related_entry_id = coalesce($4, related_entry_id), archive_file_id = coalesce($5, archive_file_id)
            where id = $1 returning *`,
          [req.params.id, b.resolution ?? null, b.internalDepartmentId ?? null, b.relatedEntryId ?? null, b.archiveFileId ?? null],
        );
        await audit(db, actorOf(user), {
          action: 'register.entry.update',
          entityType: 'register_entry',
          entityId: req.params.id,
          oldValue: { resolution: old.resolution, internalDepartmentId: old.internal_department_id, relatedEntryId: old.related_entry_id, archiveFileId: old.archive_file_id },
          newValue: b,
        });
        return updated;
      });
    },
  );

  app.get<{ Querystring: { q?: string } }>('/correspondents', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select id, name, cui, email, address from correspondent where organization_id = $1
           and ($2::text is null or name ilike '%' || $2 || '%' or cui = $2 or lower(email) = lower($2))
         order by name limit 20`,
        [user.organizationId, req.query.q || null],
      ),
    };
  });

  app.get('/archive/files', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select af.id, af.year, an.indicative, an.title, an.retention_years from archive_file af
           join archive_nomenclature_item an on an.id = af.nomenclature_item_id
          where an.organization_id = $1 and af.closed_at is null order by an.indicative, af.year desc`,
        [user.organizationId],
      ),
    };
  });

}
