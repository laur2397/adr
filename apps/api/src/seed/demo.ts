import { hashPassword } from '../auth/crypto.js';
import { maybeOne, one, query, type Db } from '../core/db.js';

/** Appends the control digit to a CUI body (for fictional demo companies). */
export function withControlDigit(body: string): string {
  const key = '753217532';
  const padded = body.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(padded[i]) * Number(key[i]);
  return `${body}${((sum * 10) % 11) % 10}`;
}

const DEPARTMENTS: Array<[string, string]> = [
  ['REG', 'Registratură'],
  ['SVF', 'Serviciul Verificare Financiară'],
  ['SM', 'Serviciul Monitorizare'],
  ['SVA', 'Serviciul Verificare Achiziții'],
  ['CFPP', 'Control Financiar Preventiv'],
  ['CON', 'Conducere'],
];

// username, full name, job title, department, roles, head of department
const USERS: Array<[string, string, string, string, string[], boolean]> = [
  ['registratura', 'Ioana Pop', 'Inspector registratură', 'REG', ['registry_inspector'], false],
  ['evf1', 'Andrei Ionescu', 'Expert verificare financiară', 'SVF', ['evf_expert'], false],
  ['evf2', 'Maria Dumitrescu', 'Expert verificare financiară', 'SVF', ['evf_expert'], false],
  ['ei1', 'Radu Constantin', 'Expert monitorizare', 'SM', ['ei_expert'], false],
  ['achizitii1', 'Elena Stan', 'Expert achiziții', 'SVA', ['procurement_expert'], false],
  ['sef.svf', 'Cristina Marin', 'Șef Serviciul Verificare Financiară', 'SVF', ['head_of_unit'], true],
  ['sef.sva', 'Mihai Georgescu', 'Șef Serviciul Verificare Achiziții', 'SVA', ['head_of_unit'], true],
  ['sef.sm', 'Laura Enache', 'Șef Serviciul Monitorizare', 'SM', ['head_of_unit'], true],
  ['cfpp', 'Dan Popescu', 'Consilier CFPP', 'CFPP', ['cfpp'], true],
  ['director', 'Gabriela Vasile', 'Director', 'CON', ['director'], true],
  ['juridic', 'Ana Nistor', 'Consilier juridic', 'CON', ['legal_advisor'], false],
  ['auditor', 'Victor Matei', 'Auditor intern', 'CON', ['auditor'], false],
];

const PROJECTS = [
  {
    smis: '302145', title: 'Modernizarea capacității de producție a SC Exemplu Mobila SRL', beneficiary: 'EXEMPLU MOBILA SRL', cuiBody: '3124578', county: 'TIMIȘ',
    contract: 'C-2025/114', contractDate: '2025-03-18', total: '2450000.00', eligible: '2100000.00', nonReimbursable: '1470000.00', expert: 'evf1',
    lines: [['1.1', 'Echipamente tehnologice', '1650000.00'], ['1.2', 'Software de producție', '250000.00'], ['2.1', 'Servicii de consultanță', '120000.00'], ['3.1', 'Publicitate', '80000.00']],
  },
  {
    smis: '302877', title: 'Reabilitarea energetică a Școlii Gimnaziale nr. 3', beneficiary: 'COMUNA EXEMPLU', cuiBody: '450123', county: 'ARAD',
    contract: 'C-2025/207', contractDate: '2025-06-02', total: '6800000.00', eligible: '6500000.00', nonReimbursable: '6370000.00', expert: 'evf2',
    lines: [['1.1', 'Lucrări de construcții', '5600000.00'], ['1.2', 'Dirigenție de șantier', '300000.00'], ['2.1', 'Proiectare', '450000.00'], ['3.1', 'Publicitate', '150000.00']],
  },
  {
    smis: '303402', title: 'Digitalizarea serviciilor TEST DIGITAL SRL', beneficiary: 'TEST DIGITAL SRL', cuiBody: '4012356', county: 'HUNEDOARA',
    contract: 'C-2026/031', contractDate: '2026-02-11', total: '980000.00', eligible: '850000.00', nonReimbursable: '595000.00', expert: 'evf1',
    lines: [['1.1', 'Echipamente IT', '420000.00'], ['1.2', 'Licențe software', '310000.00'], ['2.1', 'Instruire', '70000.00'], ['3.1', 'Publicitate', '50000.00']],
  },
];

/** Demo organization data: departments, people, programs, beneficiaries, projects. Fictional. */
export async function seedDemo(db: Db, orgId: string, password: string, log: (m: string) => void = () => undefined) {
  const deptIds: Record<string, string> = {};
  for (const [code, name] of DEPARTMENTS) {
    const d = await one(
      db,
      `insert into department (organization_id, code, name) values ($1, $2, $3) on conflict (organization_id, code) do update set name = excluded.name returning id`,
      [orgId, code, name],
    );
    deptIds[code] = d.id;
  }
  const hash = await hashPassword(password);
  const userIds: Record<string, string> = {};
  for (const [username, fullName, title, dept, roles, isHead] of USERS) {
    let u = await maybeOne(db, `select id from app_user where organization_id = $1 and username = $2`, [orgId, username]);
    if (!u) {
      u = await one(
        db,
        `insert into app_user (organization_id, username, email, full_name, job_title, department_id, password_hash) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [orgId, username, `${username}@adr-demo.ro`, fullName, title, deptIds[dept], hash],
      );
      for (const r of roles) {
        await query(db, `insert into role_assignment (user_id, role_id, department_id) select $1, id, $3 from role where organization_id = $2 and key = $4`, [
          u.id,
          orgId,
          deptIds[dept],
          r,
        ]);
      }
    }
    userIds[username] = u.id;
    if (isHead) await query(db, `update department set head_user_id = $2 where id = $1`, [deptIds[dept], u.id]);
  }
  const programs: Record<string, string> = {};
  for (const [code, name] of [
    ['PR', 'Programul Regional 2021-2027'],
    ['PTJ', 'Programul Tranziție Justă 2021-2027'],
  ]) {
    const p = await one(
      db,
      `insert into program (organization_id, code, name) values ($1, $2, $3) on conflict (organization_id, code) do update set name = excluded.name returning id`,
      [orgId, code, name],
    );
    programs[code!] = p.id;
  }
  for (const p of PROJECTS) {
    const cui = withControlDigit(p.cuiBody);
    const b = await one(
      db,
      `insert into beneficiary (organization_id, cui, name, county, address, trade_register_no, caen_code)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (organization_id, cui) do update set name = excluded.name returning id`,
      [orgId, cui, p.beneficiary, p.county, `${p.county}, Str. Exemplu nr. 1`, p.beneficiary.endsWith('SRL') ? 'J35/1234/2012' : null, p.beneficiary.endsWith('SRL') ? '3101' : '8411'],
    );
    const pr = await one(
      db,
      `insert into project (organization_id, smis_code, title, beneficiary_id, program_id, contract_number, contract_date, total_value, eligible_value,
                            non_reimbursable_value, start_date, end_date, responsible_expert_id, source, source_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7, '2027-12-31', $11, 'import', now())
       on conflict (organization_id, smis_code) do update set title = excluded.title returning id`,
      [orgId, p.smis, p.title, b.id, programs.PR, p.contract, p.contractDate, p.total, p.eligible, p.nonReimbursable, userIds[p.expert]],
    );
    for (const [code, category, amount] of p.lines) {
      await query(
        db,
        `insert into project_budget_line (project_id, code, category, eligible_amount) values ($1, $2, $3, $4) on conflict (project_id, code) do nothing`,
        [pr.id, code, category, amount],
      );
    }
  }
  for (const [indicative, title, years] of [
    ['I-1', 'Corespondență generală', 10],
    ['FE-3', 'Dosare cereri de rambursare / plată', 10],
    ['FE-4', 'Dosare verificare achiziții', 10],
    ['C-1', 'Decizii ale directorului', null],
  ] as Array<[string, string, number | null]>) {
    const item = await one(
      db,
      `insert into archive_nomenclature_item (organization_id, indicative, title, retention_years) values ($1, $2, $3, $4)
       on conflict (organization_id, indicative) do update set title = excluded.title returning id`,
      [orgId, indicative, title, years],
    );
    await query(db, `insert into archive_file (nomenclature_item_id, year) values ($1, extract(year from current_date)) on conflict do nothing`, [item.id]);
  }
  log(`demo data: ${USERS.length} users, ${PROJECTS.length} projects`);
  return userIds;
}
