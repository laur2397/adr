import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { checkCui, normalizeCui, parseAmount } from '@flux/validators';
import { userOf } from '../app.js';
import { audit } from '../audit/audit.js';
import { getPool, maybeOne, one, query, tx, type Db } from '../core/db.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { actorOf, hasRole, type CurrentUser } from '../identity/context.js';
import { lookupCompany, type AnafCompany } from '../integrations/anaf/client.js';

const EDITORS = ['functional_admin', 'head_of_unit', 'registry_inspector', 'evf_expert', 'ei_expert'];

async function saveBeneficiary(db: Db, user: CurrentUser, c: AnafCompany): Promise<string> {
  const row = await one(
    db,
    `insert into beneficiary (organization_id, cui, name, trade_register_no, caen_code, address, county, vat_payer, anaf_fetched_at, anaf_payload)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (organization_id, cui) do update set name = excluded.name, trade_register_no = excluded.trade_register_no,
       caen_code = excluded.caen_code, address = excluded.address, county = excluded.county, vat_payer = excluded.vat_payer,
       anaf_fetched_at = excluded.anaf_fetched_at, anaf_payload = excluded.anaf_payload
     returning id`,
    [user.organizationId, c.cui, c.name, c.tradeRegisterNo, c.caenCode, c.address, c.county, c.vatPayer, c.fetchedAt, JSON.stringify(c.raw)],
  );
  await audit(db, actorOf(user), { action: 'beneficiary.anaf_sync', entityType: 'beneficiary', entityId: row.id, newValue: { cui: c.cui, name: c.name, fetchedAt: c.fetchedAt } });
  return row.id;
}

const cell = (row: ExcelJS.Row, i: number): string => {
  const v = row.getCell(i).value as unknown;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v && 'result' in v) return String((v as { result: unknown }).result ?? '');
  if (typeof v === 'object' && v && 'text' in v) return String((v as { text: unknown }).text ?? '');
  return String(v).trim();
};

const dateCell = (s: string): string | null => {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  throw new Error(`data „${s}” nu este validă`);
};

export async function referenceRoutes(app: FastifyInstance) {
  app.post<{ Body: { cui: string } }>('/beneficiaries/lookup-anaf', async (req) => {
    userOf(req);
    return lookupCompany(req.body?.cui ?? '');
  });

  app.post<{ Body: { cui: string } }>('/beneficiaries', async (req, reply) => {
    const user = userOf(req);
    if (!hasRole(user, ...EDITORS)) throw forbidden();
    const company = await lookupCompany(req.body?.cui ?? '');
    const id = await tx((db) => saveBeneficiary(db, user, company));
    reply.status(201);
    return { id };
  });

  app.get<{ Querystring: { q?: string } }>('/beneficiaries', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select id, cui, name, county, trade_register_no, caen_code, anaf_fetched_at from beneficiary
          where organization_id = $1 and ($2::text is null or name ilike '%' || $2 || '%' or cui = $2) order by name limit 50`,
        [user.organizationId, req.query.q || null],
      ),
    };
  });

  app.get<{ Querystring: { q?: string; beneficiaryId?: string } }>('/projects', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select p.id, p.smis_code, p.title, p.contract_number, p.eligible_value, b.name as beneficiary_name, b.cui as beneficiary_cui,
                pr.code as program_code, u.full_name as responsible_expert
           from project p join beneficiary b on b.id = p.beneficiary_id join program pr on pr.id = p.program_id
           left join app_user u on u.id = p.responsible_expert_id
          where p.organization_id = $1 and ($2::text is null or p.smis_code = $2 or p.title ilike '%' || $2 || '%' or b.name ilike '%' || $2 || '%')
            and ($3::uuid is null or p.beneficiary_id = $3)
          order by p.smis_code limit 50`,
        [user.organizationId, req.query.q || null, req.query.beneficiaryId || null],
      ),
    };
  });

  app.get<{ Params: { id: string } }>('/projects/:id', async (req) => {
    const user = userOf(req);
    const p = await maybeOne(
      getPool(),
      `select p.*, b.name as beneficiary_name, b.cui as beneficiary_cui, pr.code as program_code from project p
         join beneficiary b on b.id = p.beneficiary_id join program pr on pr.id = p.program_id where p.id = $1 and p.organization_id = $2`,
      [req.params.id, user.organizationId],
    );
    if (!p) throw notFound('Proiectul');
    const lines = await query(getPool(), `select code, category, eligible_amount, non_eligible_amount, approved_to_date from project_budget_line where project_id = $1 order by code`, [p.id]);
    return { ...p, budgetLines: lines };
  });

  /**
   * Import of projects, contracts and budget lines from XLSX (until the MySMIS adapter exists).
   * Sheet "Proiecte": cod_smis, titlu, cui_beneficiar, program, nr_contract, data_contract, valoare_totala,
   *   valoare_eligibila, valoare_nerambursabila, data_inceput, data_sfarsit, expert_responsabil (username)
   * Sheet "Linii bugetare": cod_smis, cod_linie, categorie, suma_eligibila, suma_neeligibila
   */
  app.post('/projects/import', async (req) => {
    const user = userOf(req);
    if (!hasRole(user, 'functional_admin')) throw forbidden('Importul de proiecte este disponibil administratorului funcțional.');
    const file = await req.file();
    if (!file) throw badRequest('Alegeți fișierul XLSX.');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await file.toBuffer()) as never);
    const projects = wb.getWorksheet('Proiecte');
    const lines = wb.getWorksheet('Linii bugetare');
    if (!projects) throw badRequest('Fișierul trebuie să conțină foaia „Proiecte”.');
    const report: Array<{ sheet: string; row: number; status: 'ok' | 'error'; message: string }> = [];
    await tx(async (db) => {
      const projectRows: ExcelJS.Row[] = [];
      projects.eachRow((row, n) => n > 1 && projectRows.push(row));
      for (const row of projectRows) {
        const n = row.number;
        await db.query('savepoint r');
        try {
          const smis = cell(row, 1);
          const cui = normalizeCui(cell(row, 3));
          if (!/^\d{5,7}$/.test(smis)) throw new Error('cod SMIS invalid');
          const c = checkCui(cui);
          if (!c.ok) throw new Error(c.message);
          let ben = await maybeOne(db, `select id from beneficiary where organization_id = $1 and cui = $2`, [user.organizationId, cui]);
          if (!ben) ben = { id: await saveBeneficiary(db, user, await lookupCompany(cui)) };
          const program = await maybeOne(db, `select id from program where organization_id = $1 and code = $2`, [user.organizationId, cell(row, 4)]);
          if (!program) throw new Error(`programul „${cell(row, 4)}” nu există`);
          const expertName = cell(row, 12);
          const expert = expertName ? await maybeOne(db, `select id from app_user where organization_id = $1 and username = $2`, [user.organizationId, expertName]) : null;
          if (expertName && !expert) throw new Error(`utilizatorul „${expertName}” nu există`);
          const amount = (i: number) => (cell(row, i) ? parseAmount(cell(row, i)) : null);
          await query(
            db,
            `insert into project (organization_id, smis_code, title, beneficiary_id, program_id, contract_number, contract_date, total_value,
                                  eligible_value, non_reimbursable_value, start_date, end_date, responsible_expert_id, source, source_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'import', now())
             on conflict (organization_id, smis_code) do update set title = excluded.title, beneficiary_id = excluded.beneficiary_id,
               program_id = excluded.program_id, contract_number = excluded.contract_number, contract_date = excluded.contract_date,
               total_value = excluded.total_value, eligible_value = excluded.eligible_value, non_reimbursable_value = excluded.non_reimbursable_value,
               start_date = excluded.start_date, end_date = excluded.end_date, responsible_expert_id = excluded.responsible_expert_id,
               source = 'import', source_at = now()`,
            [user.organizationId, smis, cell(row, 2), ben.id, program.id, cell(row, 5) || null, dateCell(cell(row, 6)), amount(7), amount(8), amount(9), dateCell(cell(row, 10)), dateCell(cell(row, 11)), expert?.id ?? null],
          );
          await db.query('release savepoint r');
          report.push({ sheet: 'Proiecte', row: n, status: 'ok', message: `SMIS ${smis}` });
        } catch (e) {
          await db.query('rollback to savepoint r');
          report.push({ sheet: 'Proiecte', row: n, status: 'error', message: (e as Error).message });
        }
      }
      const lineRows: ExcelJS.Row[] = [];
      lines?.eachRow((row, n) => n > 1 && lineRows.push(row));
      for (const row of lineRows) {
        await db.query('savepoint r');
        try {
          const p = await maybeOne(db, `select id from project where organization_id = $1 and smis_code = $2`, [user.organizationId, cell(row, 1)]);
          if (!p) throw new Error(`proiectul SMIS ${cell(row, 1)} nu există`);
          await query(
            db,
            `insert into project_budget_line (project_id, code, category, eligible_amount, non_eligible_amount) values ($1, $2, $3, $4, $5)
             on conflict (project_id, code) do update set category = excluded.category, eligible_amount = excluded.eligible_amount, non_eligible_amount = excluded.non_eligible_amount`,
            [p.id, cell(row, 2), cell(row, 3), parseAmount(cell(row, 4) || '0'), parseAmount(cell(row, 5) || '0')],
          );
          await db.query('release savepoint r');
          report.push({ sheet: 'Linii bugetare', row: row.number, status: 'ok', message: `${cell(row, 1)} / ${cell(row, 2)}` });
        } catch (e) {
          await db.query('rollback to savepoint r');
          report.push({ sheet: 'Linii bugetare', row: row.number, status: 'error', message: (e as Error).message });
        }
      }
      await audit(db, actorOf(user), {
        action: 'project.import',
        entityType: 'organization',
        entityId: user.organizationId,
        newValue: { ok: report.filter((r) => r.status === 'ok').length, errors: report.filter((r) => r.status === 'error').length },
      });
    });
    return { report };
  });

  app.get<{ Params: { key: string }; Querystring: { projectId?: string } }>('/nomenclatures/:key', async (req) => {
    const user = userOf(req);
    if (req.params.key === 'project_budget_lines') {
      if (!req.query.projectId) return { items: [] };
      const rows = await query(
        getPool(),
        `select l.code, l.code || ' – ' || l.category as label from project_budget_line l join project p on p.id = l.project_id
          where p.id = $1 and p.organization_id = $2 order by l.code`,
        [req.query.projectId, user.organizationId],
      );
      return { items: rows };
    }
    const rows = await query(
      getPool(),
      `select i.code, i.label from nomenclature_item i join nomenclature n on n.id = i.nomenclature_id
        where n.organization_id = $1 and n.key = $2 and i.active order by i.position, i.label`,
      [user.organizationId, req.params.key],
    );
    return { items: rows };
  });

  app.get('/users', async (req) => {
    const user = userOf(req);
    return {
      items: await query(
        getPool(),
        `select u.id, u.username, u.full_name, u.job_title, d.name as department,
                coalesce((select array_agg(distinct r.key) from role_assignment ra join role r on r.id = ra.role_id
                           where ra.user_id = u.id and ra.valid_from <= current_date and (ra.valid_to is null or ra.valid_to >= current_date)), '{}') as roles
           from app_user u left join department d on d.id = u.department_id where u.organization_id = $1 and u.active order by u.full_name`,
        [user.organizationId],
      ),
    };
  });
}
