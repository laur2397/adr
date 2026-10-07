import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateDefinition } from '@flux/process-schema';
import { proposedRomanianHolidays } from '@flux/working-days';
import { audit } from '../audit/audit.js';
import { hashPassword } from '../auth/crypto.js';
import { maybeOne, one, query, type Db } from '../core/db.js';
import { putFile } from '../documents/storage.js';
import { buildDocx } from './docx.js';
import { TEMPLATES } from './templates.js';

const PROCESSES_DIR = fileURLToPath(new URL('../../../../processes/', import.meta.url));

export const ROLES: Array<[string, string]> = [
  ['registry_inspector', 'Inspector registratură'],
  ['evf_expert', 'Expert verificare financiară (EVF)'],
  ['ei_expert', 'Expert implementare / tehnic (EI)'],
  ['procurement_expert', 'Expert achiziții'],
  ['head_of_unit', 'Șef serviciu'],
  ['director', 'Director'],
  ['cfpp', 'Control financiar preventiv (CFPP)'],
  ['legal_advisor', 'Consilier juridic'],
  ['irregularity_officer', 'Ofițer nereguli'],
  ['accountant', 'Contabil'],
  ['functional_admin', 'Administrator funcțional'],
  ['it_admin', 'Administrator IT'],
  ['auditor', 'Auditor / cititor'],
];

/**
 * Deadline rules from the specification. All are configuration, marked "to validate" until the
 * institution's legal advisor confirms them (Administrare > Termene).
 */
export const DEADLINES = [
  { key: 'p1_verification', name: 'Verificarea cererii de plată / rambursare', day_type: 'working', days: 20, start_point: 'submission_date', pause_mode: 'suspend', max_pauses: 10, max_paused_days: null, extension_days: null, warn_before_days: 3, legal_reference: 'OUG 133/2021 art. 22 și 25 (de verificat textul consolidat: plafonul de întreruperi)' },
  { key: 'internal_financial_check_15', name: 'Țintă internă: verificare financiară', day_type: 'working', days: 15, start_point: 'step_entry', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 2, legal_reference: 'Țintă internă (raport ADR Vest)' },
  { key: 'authorization_5', name: 'Țintă internă: autorizare', day_type: 'working', days: 5, start_point: 'step_entry', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 1, legal_reference: 'Țintă internă' },
  { key: 'procurement_check_internal', name: 'Țintă internă: verificare achiziție', day_type: 'working', days: 15, start_point: 'registration_date', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 2, legal_reference: 'Țintă internă (configurabilă)' },
  { key: 'petition_og27', name: 'Răspuns la petiție', day_type: 'calendar', days: 30, start_point: 'registration_date', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: 15, warn_before_days: 5, legal_reference: 'OG 27/2002 art. 8-9' },
  { key: 'foia_544', name: 'Răspuns la cerere de informații publice', day_type: 'calendar', days: 10, start_point: 'registration_date', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: 20, warn_before_days: 2, legal_reference: 'Legea 544/2001 art. 7' },
  { key: 'irregularity_finding', name: 'Constatarea neregulii', day_type: 'working', days: 30, start_point: 'registration_date', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 5, legal_reference: 'OUG 66/2011 și normele de aplicare (de verificat termenul aplicabil)' },
  { key: 'addendum_analysis', name: 'Analiza solicitării de modificare a contractului', day_type: 'working', days: 15, start_point: 'registration_date', pause_mode: 'suspend', max_pauses: 3, max_paused_days: null, extension_days: null, warn_before_days: 3, legal_reference: 'Țintă internă / manualul de implementare' },
  { key: 'invoice_payment', name: 'Plata facturii', day_type: 'calendar', days: 30, start_point: 'step_entry', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 5, legal_reference: 'Legea 72/2013 (termen de plată pentru autorități contractante)' },
  { key: 'onsite_report', name: 'Raportul vizitei la fața locului', day_type: 'working', days: 10, start_point: 'step_entry', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 2, legal_reference: 'Țintă internă (manualul de proceduri al AM)' },
  { key: 'onsite_follow_up', name: 'Implementarea recomandărilor vizitei', day_type: 'calendar', days: 30, start_point: 'step_entry', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: 30, warn_before_days: 5, legal_reference: 'Termen stabilit în raportul vizitei (implicit 30 de zile)' },
  { key: 'correspondence_general', name: 'Răspuns la corespondență', day_type: 'calendar', days: 30, start_point: 'registration_date', pause_mode: 'suspend', max_pauses: null, max_paused_days: null, extension_days: null, warn_before_days: 5, legal_reference: 'Regulă internă' },
];

export const REGISTERS: Array<[string, string]> = [
  ['general', 'Registrul general de intrare-ieșire'],
  ['cr_cp', 'Registrul cererilor de rambursare / plată / prefinanțare'],
  ['procurements', 'Registrul verificărilor de achiziții'],
  ['contracts', 'Registrul contractelor de finanțare'],
  ['addenda', 'Registrul actelor adiționale'],
  ['decisions', 'Registrul deciziilor'],
  ['irregularities', 'Registrul neregulilor'],
  ['debtors', 'Registrul debitorilor'],
  ['guarantees', 'Registrul garanțiilor'],
  ['conflict_of_interest', 'Registrul conflictelor de interese'],
  ['necessity_reports', 'Registrul referatelor de necesitate'],
  ['payments', 'Registrul ordonanțărilor de plată'],
  ['cfpp_visas', 'Registrul vizelor de control financiar preventiv'],
  ['onsite_visits', 'Registrul verificărilor la fața locului'],
];

export const NOMENCLATURES: Record<string, { name: string; items: Array<[string, string]> }> = {
  payment_request_type: { name: 'Tip cerere', items: [['rambursare', 'rambursare'], ['plata', 'plată'], ['prefinantare', 'prefinanțare']] },
  procedure_type: {
    name: 'Procedură de atribuire',
    items: [['achizitie_directa', 'Achiziție directă'], ['procedura_simplificata', 'Procedură simplificată'], ['licitatie_deschisa', 'Licitație deschisă'], ['negociere', 'Negociere fără publicare'], ['procedura_proprie', 'Procedură proprie (beneficiar privat)']],
  },
  procurement_verdict: { name: 'Aviz achiziție', items: [['aviz_favorabil', 'Aviz favorabil'], ['aviz_cu_corectie', 'Aviz cu corecție financiară'], ['aviz_nefavorabil', 'Aviz nefavorabil']] },
  irregularity_source: {
    name: 'Sursa suspiciunii de neregulă',
    items: [['verificare_cerere', 'Verificarea unei cereri de rambursare / plată'], ['verificare_achizitie', 'Verificarea unei achiziții'], ['vizita', 'Vizită la fața locului'], ['audit', 'Misiune de audit (AA, CE, Curtea de Conturi)'], ['sesizare', 'Sesizare externă'], ['dna_olaf', 'DNA / OLAF / organe de cercetare']],
  },
  irregularity_type: {
    name: 'Tipul neregulii',
    items: [['achizitii', 'Nereguli în achiziții'], ['cheltuieli_neeligibile', 'Cheltuieli neeligibile'], ['dubla_finantare', 'Dublă finanțare'], ['conflict_interese', 'Conflict de interese'], ['indicatori', 'Nerealizarea indicatorilor'], ['frauda_suspectata', 'Suspiciune de fraudă']],
  },
  irregularity_outcome: { name: 'Rezultatul verificării', items: [['confirmata', 'Neregulă confirmată'], ['neconfirmata', 'Neregulă neconfirmată']] },
  addendum_kind: { name: 'Tip modificare contract', items: [['act_aditional', 'Act adițional'], ['notificare', 'Notificare']] },
  addendum_decision: { name: 'Propunere', items: [['aprobare', 'Aprobare'], ['respingere', 'Respingere']] },
  funding_source: {
    name: 'Sursa de finanțare',
    items: [['asistenta_tehnica', 'Asistență tehnică PR (FEDR + buget de stat)'], ['buget_stat', 'Buget de stat'], ['venituri_proprii', 'Venituri proprii']],
  },
  decision_type: {
    name: 'Tipul deciziei',
    items: [['comisie', 'Numire comisie / echipă'], ['procedura', 'Aprobare procedură / regulament'], ['delegare', 'Delegare de atribuții'], ['personal', 'Resurse umane'], ['altele', 'Altele']],
  },
  visit_reason: {
    name: 'Motivul vizitei la fața locului',
    items: [['esantion_risc', 'Eșantion – risc ridicat'], ['esantion_aleator', 'Eșantion – selecție aleatorie'], ['cerere_finala', 'Înaintea cererii de plată finale'], ['monitorizare', 'Vizită de monitorizare'], ['suspiciune', 'Suspiciune / sesizare']],
  },
  visit_result: {
    name: 'Rezultatul vizitei',
    items: [['conform', 'Conform'], ['conform_cu_recomandari', 'Conform, cu recomandări'], ['neconform', 'Neconform – se sesizează nereguli']],
  },
  correspondence_category: {
    name: 'Categorie corespondență',
    items: [['corespondenta', 'Corespondență generală'], ['petitie', 'Petiție (OG 27/2002)'], ['informatii_544', 'Informații publice (Legea 544/2001)']],
  },
};

export interface BaseSeedInput {
  organizationName: string;
  organizationCui: string;
  adminUsername: string;
  adminEmail: string;
  adminPassword: string;
}

async function installTemplates(db: Db, orgId: string, adminId: string) {
  for (const [key, t] of Object.entries(TEMPLATES)) {
    const exists = await maybeOne(db, `select 1 from document_template where organization_id = $1 and key = $2`, [orgId, key]);
    if (exists) continue;
    const stored = await putFile(buildDocx(t.blocks));
    await query(
      db,
      `insert into document_template (organization_id, key, version, name, storage_key, sha256, status, created_by) values ($1, $2, 1, $3, $4, $5, 'published', $6)`,
      [orgId, key, t.name, stored.storageKey, stored.sha256, adminId],
    );
  }
}

/** JSON with object keys sorted: jsonb does not keep key order, so a plain stringify would always differ. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Installs or upgrades the process packages: publishes a new version only when the JSON changed. */
export async function installPackages(db: Db, orgId: string, adminId: string, log: (m: string) => void = () => undefined) {
  await installTemplates(db, orgId, adminId);
  for (const dir of readdirSync(PROCESSES_DIR).sort()) {
    const base = `${PROCESSES_DIR}${dir}/`;
    if (existsSync(`${base}checklist.json`)) {
      const c = JSON.parse(readFileSync(`${base}checklist.json`, 'utf8'));
      const current = await maybeOne(db, `select id from checklist_template where organization_id = $1 and key = $2`, [orgId, c.key]);
      if (!current) {
        const t = await one(
          db,
          `insert into checklist_template (organization_id, key, version, name, answer_set, status) values ($1, $2, 1, $3, $4, 'published') returning id`,
          [orgId, c.key, c.name, c.answerSet],
        );
        let pos = 1;
        for (const i of c.items) {
          await query(db, `insert into checklist_item (template_id, position, code, question, legal_basis, observation_required_on) values ($1, $2, $3, $4, $5, $6)`, [
            t.id,
            pos++,
            i.code,
            i.question,
            i.legalBasis ?? null,
            i.observationRequiredOn ?? ['NU'],
          ]);
        }
      }
    }
    const def = JSON.parse(readFileSync(`${base}process.json`, 'utf8'));
    const v = validateDefinition(def);
    if (!v.ok) throw new Error(`processes/${dir}/process.json: ${v.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
    const published = await maybeOne(db, `select id, version, definition from process_definition where organization_id = $1 and key = $2 and status = 'published'`, [orgId, def.key]);
    if (published && canonical(published.definition) === canonical(def)) continue;
    const { next } = await one(db, `select coalesce(max(version), 0) + 1 as next from process_definition where organization_id = $1 and key = $2`, [orgId, def.key]);
    await query(db, `update process_definition set status = 'retired' where organization_id = $1 and key = $2 and status = 'published'`, [orgId, def.key]);
    await query(
      db,
      `insert into process_definition (organization_id, key, version, name, definition, status, created_by, published_at) values ($1, $2, $3, $4, $5, 'published', $6, now())`,
      [orgId, def.key, next, def.name, JSON.stringify(def), adminId],
    );
    log(`published ${def.key} v${next}`);
  }
}

/** First install: organization, administrator, roles, registers, calendar, deadlines, packages. Idempotent. */
export async function seedBase(db: Db, input: BaseSeedInput, log: (m: string) => void = () => undefined): Promise<{ organizationId: string; adminId: string }> {
  let org = await maybeOne(db, `select id from organization where cui = $1`, [input.organizationCui]);
  if (!org) {
    org = await one(db, `insert into organization (name, cui) values ($1, $2) returning id`, [input.organizationName, input.organizationCui]);
    log(`organization ${input.organizationName}`);
  }
  const orgId: string = org.id;
  for (const [key, name] of ROLES) {
    await query(db, `insert into role (organization_id, key, name) values ($1, $2, $3) on conflict (organization_id, key) do nothing`, [orgId, key, name]);
  }
  let admin = await maybeOne(db, `select id from app_user where organization_id = $1 and username = $2`, [orgId, input.adminUsername]);
  if (!admin) {
    admin = await one(
      db,
      `insert into app_user (organization_id, username, email, full_name, password_hash) values ($1, $2, $3, 'Administrator', $4) returning id`,
      [orgId, input.adminUsername, input.adminEmail, await hashPassword(input.adminPassword)],
    );
    for (const key of ['functional_admin', 'it_admin']) {
      await query(db, `insert into role_assignment (user_id, role_id) select $1, id from role where organization_id = $2 and key = $3`, [admin.id, orgId, key]);
    }
    log(`admin user ${input.adminUsername}`);
  }
  for (const [key, name] of REGISTERS) {
    await query(db, `insert into register (organization_id, key, name) values ($1, $2, $3) on conflict (organization_id, key) do nothing`, [orgId, key, name]);
  }
  for (const [key, n] of Object.entries(NOMENCLATURES)) {
    const row = await one(
      db,
      `insert into nomenclature (organization_id, key, name) values ($1, $2, $3) on conflict (organization_id, key) do update set name = excluded.name returning id`,
      [orgId, key, n.name],
    );
    let pos = 0;
    for (const [code, label] of n.items) {
      await query(db, `insert into nomenclature_item (nomenclature_id, code, label, position) values ($1, $2, $3, $4) on conflict (nomenclature_id, code) do nothing`, [
        row.id,
        code,
        label,
        pos++,
      ]);
    }
  }
  const year = new Date().getFullYear();
  for (const y of [year - 1, year, year + 1]) {
    const has = await maybeOne(db, `select 1 from holiday where organization_id = $1 and extract(year from day) = $2`, [orgId, y]);
    if (has) continue;
    for (const h of proposedRomanianHolidays(y)) {
      await query(db, `insert into holiday (organization_id, day, name) values ($1, $2, $3) on conflict do nothing`, [orgId, h.day, h.name]);
    }
  }
  for (const d of DEADLINES) {
    await query(
      db,
      `insert into deadline_definition (organization_id, key, name, day_type, days, start_point, pause_mode, max_pauses, max_paused_days, extension_days, warn_before_days, legal_reference)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (organization_id, key) do nothing`,
      [orgId, d.key, d.name, d.day_type, d.days, d.start_point, d.pause_mode, d.max_pauses, d.max_paused_days, d.extension_days, d.warn_before_days, d.legal_reference],
    );
  }
  await installPackages(db, orgId, admin.id, log);
  await audit(db, { organizationId: orgId, userId: null }, { action: 'system.seed', entityType: 'organization', entityId: orgId });
  return { organizationId: orgId, adminId: admin.id };
}
