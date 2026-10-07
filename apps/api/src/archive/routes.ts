import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, one, query, tx } from '../core/db.js';
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';

const READ = ['registry_inspector', 'functional_admin', 'head_of_unit', 'director', 'auditor'];
const MANAGE = ['registry_inspector', 'functional_admin'];
const thisYear = () => new Date().getFullYear();

function need(user: CurrentUser, roles: string[]) {
  if (!hasRole(user, ...roles)) throw forbidden('Arhiva este gestionată de registratură și administratorul funcțional.');
}

export async function archiveRoutes(app: FastifyInstance) {
  /** Archival nomenclature with its files per year, contents and retention status. */
  app.get('/archive', async (req) => {
    const user = userOf(req);
    need(user, READ);
    const items = await query(
      getPool(),
      `select n.id, n.indicative, n.title, n.retention_years, d.name as department,
              coalesce(json_agg(json_build_object(
                'id', f.id, 'year', f.year, 'closedAt', f.closed_at, 'disposedAt', f.disposed_at,
                'entries', (select count(*) from register_entry e where e.archive_file_id = f.id),
                'documents', (select count(*) from document doc where doc.archive_file_id = f.id),
                'expiresYear', case when n.retention_years is null then null else f.year + n.retention_years end
              ) order by f.year desc) filter (where f.id is not null), '[]') as files
         from archive_nomenclature_item n left join department d on d.id = n.department_id left join archive_file f on f.nomenclature_item_id = n.id
        where n.organization_id = $1 group by n.id, d.name order by n.indicative`,
      [user.organizationId],
    );
    return { items, year: thisYear() };
  });

  app.post<{ Body: { indicative: string; title: string; retentionYears?: number | null; departmentId?: string } }>('/archive/nomenclature', async (req, reply) => {
    const user = userOf(req);
    need(user, ['functional_admin']);
    const b = req.body ?? ({} as never);
    if (!b.indicative?.trim() || !b.title?.trim()) throw badRequest('Completați indicativul și denumirea.');
    const row = await tx(async (db) => {
      const r = await one(
        db,
        `insert into archive_nomenclature_item (organization_id, indicative, title, retention_years, department_id) values ($1, $2, $3, $4, $5)
         on conflict (organization_id, indicative) do update set title = excluded.title, retention_years = excluded.retention_years returning id`,
        [user.organizationId, b.indicative.trim(), b.title.trim(), b.retentionYears ?? null, b.departmentId ?? null],
      );
      await audit(db, actorOf(user), { action: 'archive.nomenclature.save', entityType: 'archive_nomenclature_item', entityId: r.id, newValue: b });
      return r;
    });
    reply.status(201);
    return row;
  });

  app.post<{ Body: { nomenclatureItemId: string; year: number } }>('/archive/files', async (req, reply) => {
    const user = userOf(req);
    need(user, MANAGE);
    const row = await tx(async (db) => {
      const item = await maybeOne(db, `select id from archive_nomenclature_item where id = $1 and organization_id = $2`, [req.body?.nomenclatureItemId, user.organizationId]);
      if (!item) throw notFound('Poziția din nomenclator');
      const r = await one(
        db,
        `insert into archive_file (nomenclature_item_id, year) values ($1, $2) on conflict (nomenclature_item_id, year) do update set year = excluded.year returning id`,
        [item.id, Number(req.body.year) || thisYear()],
      );
      await audit(db, actorOf(user), { action: 'archive.file.open', entityType: 'archive_file', entityId: r.id, newValue: req.body });
      return r;
    });
    reply.status(201);
    return row;
  });

  /** Contents of an archival file (inventory); ?format=xlsx exports the inventory. */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/archive/files/:id', async (req, reply) => {
    const user = userOf(req);
    need(user, READ);
    const file = await maybeOne(
      getPool(),
      `select f.*, n.indicative, n.title, n.retention_years from archive_file f join archive_nomenclature_item n on n.id = f.nomenclature_item_id
        where f.id = $1 and n.organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!file) throw notFound('Dosarul arhivistic');
    const entries = await query(
      getPool(),
      `select e.number_display, e.registered_at, e.direction, e.subject, e.instance_id from register_entry e where e.archive_file_id = $1 order by e.registered_at`,
      [file.id],
    );
    const documents = await query(
      getPool(),
      `select d.id, d.title, d.doc_type, d.instance_id, i.title as instance_title, i.reference_no,
              (select count(*) from document_version v where v.document_id = d.id) as versions
         from document d left join instance i on i.id = d.instance_id where d.archive_file_id = $1 order by d.created_at`,
      [file.id],
    );
    if (req.query.format === 'xlsx') {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Inventar');
      ws.addRow([`Inventar dosar ${file.indicative} – ${file.title}, anul ${file.year}`]).font = { bold: true };
      ws.addRow([`Termen de păstrare: ${file.retention_years ? `${file.retention_years} ani` : 'permanent'}`]);
      ws.addRow([]);
      ws.addRow(['Nr.', 'Tip', 'Număr / dosar', 'Conținut']).font = { bold: true };
      let n = 1;
      for (const e of entries) ws.addRow([n++, 'înregistrare', e.number_display, e.subject]);
      for (const d of documents) ws.addRow([n++, 'document', d.reference_no ?? '', `${d.title}${d.instance_title ? ` (${d.instance_title})` : ''}`]);
      ws.columns.forEach((c, i) => (c.width = [6, 14, 22, 80][i]));
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('content-disposition', `attachment; filename="inventar-${file.indicative}-${file.year}.xlsx"`);
      return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
    }
    return { ...file, entries, documents };
  });

  /** Closes an archival file at the end of the year: nothing can be added to it afterwards. */
  app.post<{ Params: { id: string } }>('/archive/files/:id/close', async (req) => {
    const user = userOf(req);
    need(user, MANAGE);
    await tx(async (db) => {
      const r = await query(
        db,
        `update archive_file f set closed_at = now(), closed_by = $3 from archive_nomenclature_item n
          where f.id = $1 and n.id = f.nomenclature_item_id and n.organization_id = $2 and f.closed_at is null returning f.id`,
        [req.params.id, user.organizationId, user.id],
      );
      if (!r.length) throw conflict('Dosarul arhivistic nu există sau este deja închis.');
      await audit(db, actorOf(user), { action: 'archive.file.close', entityType: 'archive_file', entityId: req.params.id });
    });
    return { ok: true };
  });

  /** Closed files whose retention period has expired: proposals for disposal (Legea 16/1996). */
  app.get('/archive/disposal', async (req) => {
    const user = userOf(req);
    need(user, READ);
    return {
      items: await query(
        getPool(),
        `select f.id, f.year, n.indicative, n.title, n.retention_years, f.year + n.retention_years as expired_in, f.disposed_at, f.disposal_decision,
                (select count(*) from document d where d.archive_file_id = f.id) as documents
           from archive_file f join archive_nomenclature_item n on n.id = f.nomenclature_item_id
          where n.organization_id = $1 and n.retention_years is not null and f.closed_at is not null
            and f.year + n.retention_years < extract(year from current_date)
          order by f.year`,
        [user.organizationId],
      ),
    };
  });

  app.post<{ Params: { id: string }; Body: { decision: string } }>('/archive/files/:id/dispose', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'director', 'functional_admin')) throw forbidden('Eliminarea se aprobă de director, pe baza avizului comisiei de selecționare.');
    if (!req.body?.decision?.trim()) throw badRequest('Completați decizia comisiei de selecționare și avizul Arhivelor Naționale.');
    await tx(async (db) => {
      const r = await query(
        db,
        `update archive_file f set disposed_at = now(), disposed_by = $3, disposal_decision = $4 from archive_nomenclature_item n
          where f.id = $1 and n.id = f.nomenclature_item_id and n.organization_id = $2 and f.closed_at is not null and f.disposed_at is null
            and n.retention_years is not null and f.year + n.retention_years < extract(year from current_date) returning f.id`,
        [req.params.id, user.organizationId, user.id, req.body.decision.trim()],
      );
      if (!r.length) throw conflict('Dosarul nu poate fi eliminat: nu este închis, termenul nu a expirat sau este permanent.');
      await audit(db, actorOf(user), { action: 'archive.file.dispose', entityType: 'archive_file', entityId: req.params.id, newValue: { decision: req.body.decision } });
    });
    return { ok: true };
  });

  /** Classifies a dossier (its documents and registrations) into an open archival file. */
  app.post<{ Params: { id: string }; Body: { archiveFileId: string } }>('/instances/:id/archive', async (req) => {
    const user = userOf(req);
    need(user, [...MANAGE, 'head_of_unit']);
    await requireView(getPool(), user, req.params.id);
    await tx(async (db) => {
      const file = await maybeOne(
        db,
        `select f.id from archive_file f join archive_nomenclature_item n on n.id = f.nomenclature_item_id where f.id = $1 and n.organization_id = $2 and f.closed_at is null`,
        [req.body?.archiveFileId, user.organizationId],
      );
      if (!file) throw badRequest('Alegeți un dosar arhivistic deschis.');
      await query(db, `update document set archive_file_id = $2 where instance_id = $1`, [req.params.id, file.id]);
      await query(db, `update register_entry set archive_file_id = $2 where instance_id = $1`, [req.params.id, file.id]);
      await audit(db, actorOf(user), { action: 'archive.classify', entityType: 'instance', entityId: req.params.id, newValue: { archiveFileId: file.id } });
    });
    return { ok: true };
  });
}
