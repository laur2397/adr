/**
 * Demo activity simulator. It drives the real API (same routes, validations, rights, signatures,
 * registers and deadlines) as the demo users would, in chronological order over the past months,
 * then moves the timestamps of each action to its simulated moment. Dossiers started recently
 * stay open at whatever step their timeline reached today, so every screen has realistic content.
 *
 * For demo databases only: it rewrites timestamps (and re-chains the audit log accordingly).
 */
import type { FastifyInstance } from 'fastify';
import { proposedRomanianHolidays, WorkingCalendar, addDays, toIso } from '@flux/working-days';
import { buildApp } from '../app.js';
import { setTodayOverride, today } from '../core/config.js';
import { getPool, query } from '../core/db.js';
import { scanDeadlines } from '../deadlines/service.js';
import { withControlDigit } from './demo.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

class As {
  cookie = '';
  constructor(
    private readonly app: FastifyInstance,
    readonly username: string,
  ) {}

  async login(password: string) {
    const r = await this.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: this.username, password }, headers: { 'x-flux-csrf': '1' } });
    if (r.statusCode !== 200) throw new Error(`login ${this.username}: ${r.body}`);
    const set = r.headers['set-cookie'];
    this.cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
  }

  async call(method: Method, url: string, payload?: unknown, allowFail = false): Promise<any> {
    const send = () => this.app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { cookie: this.cookie, 'x-flux-csrf': '1' } });
    let r = await send();
    // Verifiers declare the absence of a conflict of interest the first time they act on a dossier.
    if (r.statusCode === 422 && r.json().code === 'coi_required') {
      const id = /\/instances\/([0-9a-f-]{36})/.exec(url)?.[1] ?? (url.startsWith('/tasks/') ? await this.instanceOfTask(url.split('/')[2]!) : null);
      if (id) {
        await this.app.inject({ method: 'POST', url: `/api/v1/instances/${id}/coi`, payload: { hasConflict: false }, headers: { cookie: this.cookie, 'x-flux-csrf': '1' } });
        r = await send();
      }
    }
    if (r.statusCode >= 300) {
      if (allowFail) return null;
      throw new Error(`${this.username} ${method} ${url}: ${r.statusCode} ${r.body.slice(0, 400)}`);
    }
    return r.body ? r.json() : null;
  }

  private async instanceOfTask(taskId: string) {
    const rows = await query(getPool(), `select instance_id from task where id = $1`, [taskId]);
    return rows[0]?.instance_id ?? null;
  }

  async task(instanceId: string, stepKey?: string) {
    const d = await this.call('GET', `/instances/${instanceId}`);
    return d.tasks.find((t: any) => t.canAct && (!stepKey || t.stepKey === stepKey)) ?? null;
  }

  /** Claims a queued task if needed, then returns it. */
  async take(instanceId: string, stepKey: string) {
    let t = await this.task(instanceId, stepKey);
    if (!t) return null;
    if (!t.assignee) {
      await this.call('POST', `/tasks/${t.id}/claim`);
      t = await this.task(instanceId, stepKey);
    }
    return t;
  }

  async fields(instanceId: string, stepKey: string, fields: Record<string, unknown>) {
    const t = await this.take(instanceId, stepKey);
    if (!t) throw new Error(`${this.username}: no task ${stepKey} in ${instanceId}`);
    return this.call('PATCH', `/instances/${instanceId}/fields`, { taskId: t.id, fields });
  }

  async list(instanceId: string, stepKey: string, key: string, rows: unknown[]) {
    const t = await this.take(instanceId, stepKey);
    return this.call('PUT', `/instances/${instanceId}/lists/${key}`, { taskId: t.id, rows });
  }

  async checklist(instanceId: string, stepKey: string, key: string, responses: Array<{ code: string; answer: string; observation?: string }>) {
    const t = await this.take(instanceId, stepKey);
    return this.call('PUT', `/instances/${instanceId}/checklists/${key}/responses`, { taskId: t.id, responses });
  }

  async sign(instanceId: string, docKey: string) {
    // "already signed" (409) is fine: e.g. a director signing again after a return of a later step
    const r = await this.app.inject({ method: 'POST', url: `/api/v1/instances/${instanceId}/documents/${docKey}/sign`, payload: {}, headers: { cookie: this.cookie, 'x-flux-csrf': '1' } });
    if (r.statusCode >= 300 && r.statusCode !== 409) throw new Error(`${this.username} sign ${docKey}: ${r.statusCode} ${r.body.slice(0, 300)}`);
  }

  async go(instanceId: string, stepKey: string, path: string, extra: Record<string, unknown> = {}) {
    const t = await this.take(instanceId, stepKey);
    if (!t) throw new Error(`${this.username}: no task ${stepKey} for ${path}`);
    return this.call('POST', `/instances/${instanceId}/transitions`, { taskId: t.id, path, ...extra });
  }

  async comment(instanceId: string, body: string) {
    return this.call('POST', `/instances/${instanceId}/comments`, { body }, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Time: deterministic randomness, working days, timestamp shifting
// ---------------------------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLE_TIMES: Array<[string, string[]]> = [
  ['instance', ['started_at', 'finished_at']],
  ['execution', ['entered_at', 'left_at']],
  ['task', ['created_at', 'completed_at']],
  ['step_history', ['entered_at', 'left_at']],
  ['register_entry', ['registered_at']],
  ['document', ['created_at']],
  ['document_version', ['created_at']],
  ['signature', ['created_at', 'signed_at', 'invalidated_at']],
  ['instance_comment', ['created_at']],
  ['notification', ['created_at']],
  ['instance_field', ['updated_at', 'source_at']],
  ['instance_list_row', ['updated_at']],
  ['instance_acl', ['granted_at']],
  ['coi_declaration', ['declared_at']],
  ['debt', ['created_at']],
  ['debt_payment', ['created_at']],
  ['deadline', ['closed_at', 'last_reminder_at', 'escalated_at']],
  ['job_outbox', ['created_at', 'run_after', 'dispatched_at']],
  ['mail_message', ['created_at', 'processed_at']],
  ['sampling_plan', ['created_at']],
  ['substitution', ['created_at']],
  ['audit_event', ['occurred_at']],
];

async function stamp(since: string, at: Date) {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('begin');
    // The audit log refuses updates by design; the demo re-dates it and re-chains it at the end.
    await client.query('set local session_replication_role = replica');
    for (const [table, cols] of TABLE_TIMES) {
      for (const c of cols) {
        await client.query(`update flux.${table} set ${c} = $2::timestamptz + (${c} - $1::timestamptz) where ${c} >= $1::timestamptz`, [since, at.toISOString()]);
      }
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/** Recomputes the audit hash chain after re-dating (same formula as the insert trigger). */
async function rechainAudit() {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`
      do $$
      declare r record; prev bytea := null;
      begin
        for r in select * from flux.audit_event order by id loop
          update flux.audit_event set prev_hash = prev, hash = digest(
            coalesce(encode(prev, 'hex'), '') || '|' || r.id::text || '|' || (r.occurred_at at time zone 'UTC')::text || '|' || r.organization_id::text || '|' ||
            coalesce(r.actor_user_id::text, '') || '|' || coalesce(r.on_behalf_of_user_id::text, '') || '|' ||
            r.action || '|' || r.entity_type || '|' || r.entity_id || '|' ||
            coalesce(r.old_value::text, '') || '|' || coalesce(r.new_value::text, '') || '|' || coalesce(host(r.ip), ''), 'sha256')
          where id = r.id returning hash into prev;
        end loop;
      end $$;`);
    await client.query('commit');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------------------------

interface World {
  as: Record<string, As>;
  projects: Array<{ id: string; smis: string; lines: string[]; expert: string }>;
  rnd: () => number;
  pick: <T>(xs: T[]) => T;
  suppliers: Array<{ cui: string; name: string }>;
  sharedInvoice: { cui: string; no: string; date: string; amount: string };
}

type Step = { day: number; hour?: number };
type Scenario = AsyncGenerator<Step, void, void>;

const SUPPLIER_NAMES = ['TEHNO UTILAJ SRL', 'BIROTICA VEST SRL', 'CONSTRUCT EXEMPLU SA', 'SOFT SOLUTIONS SRL', 'CONSULT PROIECT SRL', 'MEDIA PUBLICITATE SRL', 'INSTAL TERM SRL'];
const SUPPLIER_BODIES = ['2245871', '3398712', '1188234', '4012399', '3876511', '2765430', '4123456'];

function money(n: number) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

const CLARIFICATIONS = [
  'Transmiteți extrasul de cont care dovedește plata facturii furnizorului de echipamente.',
  'Prezentați procesul-verbal de recepție semnat pentru lucrările facturate.',
  'Clarificați diferența dintre cantitățile din situația de lucrări și cele din factură.',
  'Transmiteți contractul de achiziție și dovada publicării anunțului în SEAP.',
];

const FINDINGS = [
  'Cheltuielile au fost verificate pe bază de documente; plățile sunt dovedite prin extrase de cont.',
  'Documentele justificative sunt complete. Nu s-au identificat cheltuieli neeligibile.',
  'S-a diminuat suma solicitată pentru cheltuieli efectuate în afara perioadei de eligibilitate.',
  'Cheltuielile cu publicitatea depășesc plafonul aprobat; diferența este neeligibilă.',
];

async function* p1(w: World, start: number, opts: { clarify: boolean; doubleCheck: boolean; returnOnce: boolean; type: string; projectIdx: number; reuseInvoice?: boolean }): Scenario {
  const { as } = w;
  const project = w.projects[opts.projectIdx % w.projects.length]!;
  const expert = as[project.expert]!;
  yield { day: start, hour: 9 };
  const { id } = await as.registratura!.call('POST', '/instances', { definitionKey: 'p1_payment_request_check', projectId: project.id });
  const n = Math.floor(w.rnd() * 9) + 1;
  await as.registratura!.fields(id, 'registration', {
    request_no: `CR-${n}`,
    request_type: opts.type,
    submitted_at: addDays(toIso(dateOf(start)), -1),
    double_check: opts.doubleCheck,
    beneficiary_iban: 'RO49AAAA1B31007593840000',
  });
  await as.registratura!.go(id, 'registration', 'register_and_assign');

  yield { day: start + 1, hour: 10 };
  const rows = [];
  const count = 2 + Math.floor(w.rnd() * 3);
  for (let i = 0; i < count; i++) {
    const s = w.pick(w.suppliers);
    const requested = money(5000 + w.rnd() * 180000);
    const reduce = w.rnd() < 0.3;
    const eligible = reduce ? money(Number(requested) * (0.8 + w.rnd() * 0.15)) : requested;
    rows.push({
      budget_line: w.pick(project.lines),
      document_ref: `Factura și OP`,
      supplier_cui: s.cui,
      invoice_no: `F${Math.floor(1000 + w.rnd() * 8999)}/2026`,
      invoice_date: addDays(toIso(dateOf(start)), -15 - Math.floor(w.rnd() * 40)),
      requested,
      eligible,
      reason: reduce ? 'Cheltuială peste prețul de piață / în afara perioadei de eligibilitate' : null,
    });
  }
  if (opts.reuseInvoice) {
    const inv = w.sharedInvoice;
    rows.push({ budget_line: w.pick(project.lines), document_ref: 'Factura și OP', supplier_cui: inv.cui, invoice_no: inv.no, invoice_date: inv.date, requested: inv.amount, eligible: inv.amount, reason: null });
  }
  await expert.list(id, 'evf_check', 'expenses', rows);
  if (opts.clarify) {
    await expert.fields(id, 'evf_check', { clarification_questions: w.pick(CLARIFICATIONS) });
    await expert.comment(id, `@sef.svf am cerut clarificări beneficiarului; termenul de verificare este suspendat.`);
    await expert.go(id, 'evf_check', 'request_clarifications');
    yield { day: start + 6, hour: 11 };
    await expert.go(id, 'clarifications', 'answer_received');
  }
  yield { day: start + (opts.clarify ? 8 : 3), hour: 14 };
  await expert.fields(id, 'evf_check', { findings: rows.some((r) => r.reason) ? FINDINGS[2] : w.pick([FINDINGS[0]!, FINDINGS[1]!]) });
  await expert.checklist(id, 'evf_check', 'verification', Array.from({ length: 8 }, (_, i) => ({ code: String(i + 1), answer: i === 4 && w.rnd() < 0.3 ? 'NA' : 'DA' })));
  await expert.sign(id, 'verification_note');
  await expert.go(id, 'evf_check', 'submit');
  if (opts.doubleCheck) {
    yield { day: start + (opts.clarify ? 9 : 4), hour: 10 };
    await as.ei1!.checklist(id, 'ei_check', 'verification', Array.from({ length: 8 }, (_, i) => ({ code: String(i + 1), answer: 'DA' })));
    await as.ei1!.go(id, 'ei_check', 'submit');
  }
  const base = start + (opts.clarify ? 10 : 5);
  yield { day: base, hour: 11 };
  const head = as['sef.svf']!;
  if (opts.returnOnce) {
    await head.go(id, 'head_review', 'return', { comment: 'Atașați procesul-verbal de recepție pentru linia 1.1 și refaceți nota.' });
    yield { day: base + 1, hour: 10 };
    await expert.comment(id, 'Am completat PV-ul de recepție și am regenerat nota.');
    await expert.fields(id, 'evf_check', { findings: `${FINDINGS[0]} PV de recepție nr. 12/2026 atașat.` });
    await expert.sign(id, 'verification_note');
    await expert.go(id, 'evf_check', 'submit');
    yield { day: base + 2, hour: 12 };
  }
  if (w.rnd() < 0.5) await head.comment(id, `@director nota de verificare este completă; propun ${opts.type === 'rambursare' ? 'aprobarea' : 'viza CFPP și aprobarea'}.`);
  await head.sign(id, 'verification_note');
  await head.go(id, 'head_review', 'endorse');
  if (opts.type !== 'rambursare') {
    yield { day: base + 3, hour: 10 };
    await as.cfpp!.sign(id, 'verification_note');
    await as.cfpp!.go(id, 'cfpp', 'grant');
  }
  yield { day: base + 4, hour: 15 };
  const dir = as.director!;
  await dir.sign(id, 'verification_note');
  await dir.sign(id, 'authorization_notice');
  await dir.go(id, 'director_approval', 'approve');
}

async function* p2(w: World, start: number, opts: { correction: boolean; projectIdx: number }): Scenario {
  const { as } = w;
  const project = w.projects[opts.projectIdx % w.projects.length]!;
  yield { day: start, hour: 9 };
  const { id } = await as.registratura!.call('POST', '/instances', { definitionKey: 'p2_procurement_check', projectId: project.id });
  const s = w.pick(w.suppliers);
  await as.registratura!.fields(id, 'registration', {
    procurement_object: w.pick(['Achiziție echipamente tehnologice', 'Lucrări de reabilitare', 'Servicii de consultanță', 'Echipamente IT', 'Servicii de publicitate']),
    procedure_type: w.pick(['achizitie_directa', 'procedura_simplificata', 'licitatie_deschisa', 'procedura_proprie']),
    contract_value: money(80000 + w.rnd() * 2500000),
    supplier_name: s.name,
    supplier_cui: s.cui,
  });
  await as.registratura!.go(id, 'registration', 'register');
  yield { day: start + 3, hour: 13 };
  const ex = as.achizitii1!;
  await ex.checklist(id, 'procurement_check', 'procurement', Array.from({ length: 12 }, (_, i) => ({
    code: String(i + 1),
    answer: opts.correction && i === 4 ? 'DA_CU_OBS' : 'DA',
    observation: opts.correction && i === 4 ? 'Specificațiile tehnice indică o marcă fără mențiunea „sau echivalent”.' : undefined,
  })));
  await ex.fields(id, 'procurement_check', opts.correction
    ? { findings: 'Specificații tehnice restrictive (marcă fără „sau echivalent”), încălcare a art. 155 din Legea 98/2016.', verdict: 'aviz_cu_corectie', correction_percent: 10 }
    : { findings: 'Procedura a fost derulată cu respectarea legislației în domeniul achizițiilor publice.', verdict: 'aviz_favorabil' });
  await ex.sign(id, 'procurement_note');
  await ex.go(id, 'procurement_check', 'submit');
  yield { day: start + 5, hour: 11 };
  await as['sef.sva']!.sign(id, 'procurement_note');
  await as['sef.sva']!.go(id, 'head_review', 'endorse');
  yield { day: start + 6, hour: 15 };
  await as.director!.sign(id, 'procurement_note');
  await as.director!.go(id, 'director_approval', 'approve');
  if (opts.correction) {
    // The approval with a financial correction opened an irregularity dossier (P4 sub-flow).
    const child = await query(getPool(), `select id from instance where parent_instance_id = $1`, [id]);
    if (child[0]) yield* p4Continue(w, child[0].id, start + 7, true);
  }
}

async function* p4Continue(w: World, id: string, start: number, confirmed: boolean): Scenario {
  const { as } = w;
  yield { day: start, hour: 10 };
  await as.nereguli!.go(id, 'registration', 'register');
  yield { day: start + 8, hour: 14 };
  const principal = money(15000 + w.rnd() * 220000);
  await as.nereguli!.fields(id, 'assessment', confirmed
    ? { irregularity_type: 'achizitii', finding: 'Se confirmă neregula: specificații restrictive care au limitat concurența. Se aplică o corecție financiară de 10% din valoarea contractului (HG 519/2014, anexa, pct. 2.4).', legal_basis: 'OUG 66/2011, art. 6 și HG 519/2014', debt_principal: principal, debt_due_date: toIso(dateOf(start + 40)), outcome: 'confirmata', ims_report: Number(principal) > 49700 }
    : { finding: 'Din verificarea documentelor nu rezultă o abatere de la legislație. Suspiciunea nu se confirmă.', outcome: 'neconfirmata' });
  await as.nereguli!.sign(id, 'finding_report');
  await as.nereguli!.go(id, 'assessment', confirmed ? 'irregularity' : 'no_irregularity');
  yield { day: start + 10, hour: 11 };
  await as['sef.sn']!.sign(id, 'finding_report');
  await as['sef.sn']!.go(id, 'head_review', 'endorse');
  yield { day: start + 12, hour: 15 };
  await as.director!.sign(id, 'finding_report');
  if (confirmed) {
    await as.director!.sign(id, 'debt_title');
    await as.director!.go(id, 'director_approval', 'approve_debt');
    const debt = await query(getPool(), `select id, principal from debt where instance_id = $1`, [id]);
    if (debt[0] && w.rnd() < 0.75) {
      yield { day: start + 30, hour: 10 };
      const part = w.rnd() < 0.5 ? debt[0].principal : money(Number(debt[0].principal) * 0.4);
      await as.contabil!.call('POST', `/debts/${debt[0].id}/payments`, { amount: part, paidOn: toIso(dateOf(start + 30)), reference: `OP ${Math.floor(100 + w.rnd() * 800)}/${toIso(dateOf(start + 30))}`, kind: w.rnd() < 0.5 ? 'payment' : 'offset' });
    }
  } else {
    await as.director!.go(id, 'director_approval', 'approve_close');
  }
}

async function* p4Standalone(w: World, start: number, projectIdx: number, confirmed: boolean): Scenario {
  const { as } = w;
  const project = w.projects[projectIdx % w.projects.length]!;
  yield { day: start, hour: 9 };
  const { id } = await as.evf2!.call('POST', '/instances', { definitionKey: 'p4_irregularities', projectId: project.id });
  await as.evf2!.fields(id, 'registration', {
    source: 'verificare_cerere',
    suspicion: 'La verificarea cererii de rambursare s-a constatat că aceeași factură a fost decontată și într-un alt proiect al beneficiarului (posibilă dublă finanțare).',
    affected_amount: money(30000 + w.rnd() * 90000),
  });
  await as.evf2!.go(id, 'registration', 'register');
  yield* p4ContinueAfterRegistration(w, id, start + 1, confirmed);
}

/** A P4 dossier opened and registered by the reporting expert: the irregularity officer continues. */
async function* p4ContinueAfterRegistration(w: World, id: string, start: number, confirmed: boolean): Scenario {
  const { as } = w;
  yield { day: start + 7, hour: 14 };
  const principal = money(20000 + w.rnd() * 60000);
  await as.nereguli!.fields(id, 'assessment', confirmed
    ? { irregularity_type: 'dubla_finantare', finding: 'Factura a fost decontată în două proiecte. Suma aferentă devine creanță bugetară.', legal_basis: 'OUG 66/2011, art. 2 alin. (1) lit. a)', debt_principal: principal, debt_due_date: toIso(dateOf(start + 40)), outcome: 'confirmata' }
    : { finding: 'Facturile sunt distincte (serii diferite). Suspiciunea nu se confirmă.', outcome: 'neconfirmata' });
  await as.nereguli!.sign(id, 'finding_report');
  await as.nereguli!.go(id, 'assessment', confirmed ? 'irregularity' : 'no_irregularity');
  yield { day: start + 9, hour: 11 };
  await as['sef.sn']!.sign(id, 'finding_report');
  await as['sef.sn']!.go(id, 'head_review', 'endorse');
  yield { day: start + 11, hour: 15 };
  await as.director!.sign(id, 'finding_report');
  if (confirmed) {
    await as.director!.sign(id, 'debt_title');
    await as.director!.go(id, 'director_approval', 'approve_debt');
  } else {
    await as.director!.go(id, 'director_approval', 'approve_close');
  }
}

async function* p3(w: World, start: number, opts: { addendum: boolean; projectIdx: number; reject?: boolean }): Scenario {
  const { as } = w;
  const project = w.projects[opts.projectIdx % w.projects.length]!;
  yield { day: start, hour: 10 };
  const { id } = await as.registratura!.call('POST', '/instances', { definitionKey: 'p3_addenda', projectId: project.id });
  await as.registratura!.fields(id, 'registration', {
    request_no: `${Math.floor(100 + w.rnd() * 900)}`,
    request_date: addDays(toIso(dateOf(start)), -2),
    kind: opts.addendum ? 'act_aditional' : 'notificare',
    changes: opts.addendum ? 'Prelungirea perioadei de implementare cu 6 luni, ca urmare a întârzierilor în livrarea echipamentelor.' : 'Modificarea echipei de implementare (înlocuirea managerului de proiect).',
    justification: 'Furnizorul a notificat întârzieri în lanțul de aprovizionare; contractul de achiziție a fost prelungit prin act adițional.',
    new_end_date: opts.addendum ? '2028-06-30' : null,
  });
  await as.registratura!.go(id, 'registration', 'register');
  yield { day: start + 4, hour: 13 };
  await as.ei1!.fields(id, 'analysis', { analysis: opts.reject ? 'Solicitarea nu este justificată: întârzierile sunt imputabile beneficiarului.' : 'Modificarea este justificată și nu afectează indicatorii proiectului. Se propune aprobarea.', decision: opts.reject ? 'respingere' : 'aprobare' });
  await as.ei1!.sign(id, 'analysis_note');
  await as.ei1!.go(id, 'analysis', 'submit');
  if (opts.addendum) {
    yield { day: start + 6, hour: 11 };
    await as.juridic!.fields(id, 'legal_review', { legal_opinion: 'Modificarea se încadrează în prevederile contractului de finanțare (art. 9) și ale ghidului solicitantului. Aviz favorabil.' });
    await as.juridic!.go(id, 'legal_review', 'favorable');
  }
  yield { day: start + 8, hour: 10 };
  await as['sef.sm']!.sign(id, 'analysis_note');
  await as['sef.sm']!.go(id, 'head_review', 'endorse');
  yield { day: start + 9, hour: 16 };
  if (opts.reject) {
    await as.director!.go(id, 'director_approval', 'reject', { comment: 'Respins conform analizei expertului; beneficiarul poate relua solicitarea cu documente justificative.' });
    return;
  }
  await as.director!.sign(id, 'analysis_note');
  await as.director!.sign(id, 'addendum');
  await as.director!.go(id, 'director_approval', 'approve');
}

const PETITIONS: Array<[string, string, string, string]> = [
  ['petitie', 'Ion Cetățean', 'ion.cetatean@example.ro', 'Petiție privind întârzierea plăților către un beneficiar din județul Timiș'],
  ['informatii_544', 'Asociația Transparență Civică', 'contact@transparenta-exemplu.ro', 'Solicitare informații publice: lista contractelor semnate în 2026'],
  ['corespondenta', 'Ministerul Investițiilor și Proiectelor Europene', 'secretariat@mipe-exemplu.ro', 'Solicitare raport privind stadiul absorbției PR 2021-2027'],
  ['corespondenta', 'Primăria Exemplu', 'registratura@primaria-exemplu.ro', 'Invitație la ședința partenerială privind mobilitatea urbană'],
  ['petitie', 'Maria Ionescu', 'maria.ionescu@example.ro', 'Sesizare privind afișarea panoului de proiect'],
  ['informatii_544', 'Jurnalist Exemplu', 'redactie@ziar-exemplu.ro', 'Cerere privind sumele rambursate beneficiarilor privați'],
  ['corespondenta', 'Curtea de Conturi', 'office@curtea-exemplu.ro', 'Notificare privind misiunea de audit financiar'],
];

async function* p5(w: World, start: number, idx: number, answerer: string, finish: boolean): Scenario {
  const { as } = w;
  const [category, sender, email, subject] = PETITIONS[idx % PETITIONS.length]!;
  yield { day: start, hour: 9 };
  const entry = await as.registratura!.call('POST', '/registers/general/entries', {
    direction: 'in',
    subject,
    sender: { name: sender, email },
    channel: w.pick(['email', 'desk', 'post']),
    startProcess: { definitionKey: 'p5_correspondence', fields: { category } },
  });
  const id = entry.instanceId;
  await as.registratura!.go(id, 'registration', 'send');
  yield { day: start + 1, hour: 10 };
  const target = await query(getPool(), `select id from app_user where username = $1`, [answerer]);
  await as.director!.fields(id, 'resolution', { resolution: `Se repartizează pentru analiză și formularea răspunsului în termenul legal.` });
  await as.director!.go(id, 'resolution', 'assign', { assignTo: target[0]!.id });
  if (!finish) return;
  yield { day: start + 6, hour: 14 };
  await as[answerer]!.fields(id, 'handling', { reply_summary: `Ca urmare a solicitării dumneavoastră, vă comunicăm că ${category === 'informatii_544' ? 'informațiile solicitate sunt publicate pe pagina de internet a instituției, secțiunea „Informații publice”, și sunt anexate prezentului răspuns' : 'aspectele semnalate au fost analizate, iar măsurile necesare au fost dispuse'}.` });
  await as[answerer]!.sign(id, 'reply_letter');
  await as[answerer]!.go(id, 'handling', 'reply');
  yield { day: start + 8, hour: 11 };
  const head = await query(getPool(), `select hu.username from app_user u join department d on d.id = u.department_id join app_user hu on hu.id = d.head_user_id where u.username = $1`, [answerer]);
  const h = as[head[0]?.username ?? 'sef.svf']!;
  await h.sign(id, 'reply_letter');
  await h.go(id, 'head_approval', 'sign');
}

async function* p6(w: World, start: number, drafter: string, depth: number): Scenario {
  const { as } = w;
  yield { day: start, hour: 10 };
  const purpose = w.pick(['Achiziție laptopuri pentru experții de verificare', 'Servicii de traducere documente pentru misiunea de audit', 'Licențe software de semnătură electronică', 'Echipamente de scanare pentru registratură', 'Servicii de organizare a sesiunii de informare a beneficiarilor']);
  const { id } = await as[drafter]!.call('POST', '/instances', { definitionKey: 'p6_necessity_payment', title: `Referat: ${purpose}` });
  await as[drafter]!.fields(id, 'draft', { purpose, justification: 'Necesar pentru buna desfășurare a activității, conform planului anual de achiziții.', funding_source: w.pick(['asistenta_tehnica', 'buget_stat']), budget_line: '20.01.30' });
  const qty = 1 + Math.floor(w.rnd() * 6);
  await as[drafter]!.list(id, 'draft', 'items', [
    { description: purpose.replace('Achiziție ', '').replace('Servicii de ', ''), quantity: qty, unit_price: money(800 + w.rnd() * 6000), vat_rate: 21 },
    { description: 'Livrare și instalare', quantity: 1, unit_price: money(150 + w.rnd() * 500), vat_rate: 21 },
  ]);
  await as[drafter]!.sign(id, 'necessity_report');
  await as[drafter]!.go(id, 'draft', 'submit');
  if (depth < 1) return;
  const head = await query(getPool(), `select hu.username from app_user u join department d on d.id = u.department_id join app_user hu on hu.id = d.head_user_id where u.username = $1`, [drafter]);
  const h = as[head[0]?.username ?? 'sef.svf']!;
  yield { day: start + 1, hour: 11 };
  await h.sign(id, 'necessity_report');
  await h.go(id, 'head_approval', 'approve');
  yield { day: start + 2, hour: 12 };
  await as.cfpp!.sign(id, 'necessity_report');
  await as.cfpp!.go(id, 'cfpp_commitment', 'grant');
  yield { day: start + 3, hour: 9 };
  await as.director!.sign(id, 'necessity_report');
  await as.director!.go(id, 'director_commitment', 'approve');
  if (depth < 2) return;
  yield { day: start + 15, hour: 13 };
  const d = await as[drafter]!.call('GET', `/instances/${id}`);
  const total = d.fields.find((f: any) => f.key === 'total').value;
  const s = w.pick(w.suppliers);
  await as[drafter]!.fields(id, 'reception', { supplier_name: s.name, supplier_cui: s.cui, supplier_iban: 'RO49AAAA1B31007593840000', invoice_no: `FV ${Math.floor(1000 + w.rnd() * 9000)}`, invoice_date: toIso(dateOf(start + 14)), invoice_amount: total, reception_note: 'Bunurile au fost recepționate cantitativ și calitativ; PV de recepție nr. 45.' });
  await as[drafter]!.go(id, 'reception', 'submit');
  yield { day: start + 16, hour: 10 };
  await as.contabil!.sign(id, 'payment_authorization');
  await as.contabil!.go(id, 'authorization', 'submit');
  yield { day: start + 17, hour: 11 };
  await as.cfpp!.sign(id, 'payment_authorization');
  await as.cfpp!.go(id, 'cfpp_payment', 'grant');
  yield { day: start + 17, hour: 15 };
  await as.director!.sign(id, 'payment_authorization');
  await as.director!.go(id, 'director_payment', 'approve');
  if (depth < 3) return;
  yield { day: start + 18, hour: 10 };
  await as.contabil!.fields(id, 'payment', { payment_order_no: `OP ${Math.floor(200 + w.rnd() * 700)}`, payment_date: toIso(dateOf(start + 18)) });
  await as.contabil!.go(id, 'payment', 'paid');
}

const DECISIONS: Array<[string, string, string]> = [
  ['comisie', 'constituirea comisiei de evaluare a cererilor de finanțare – apelul PR/2026/1', 'Art. 1. Se constituie comisia de evaluare în următoarea componență: … Art. 2. Comisia își desfășoară activitatea conform ghidului solicitantului.'],
  ['procedura', 'aprobarea procedurii operaționale „Verificarea cererilor de rambursare”, ediția 3', 'Art. 1. Se aprobă procedura operațională PO-SVF-03, ediția 3, prevăzută în anexă. Art. 2. Procedura se aplică de la data comunicării.'],
  ['delegare', 'delegarea atribuțiilor de semnare pe perioada concediului directorului', 'Art. 1. Pe perioada concediului de odihnă, atribuțiile de ordonator de credite se deleagă directorului adjunct.'],
  ['personal', 'aprobarea planului anual de formare profesională 2026', 'Art. 1. Se aprobă planul anual de formare profesională prevăzut în anexă.'],
  ['comisie', 'numirea comisiei de selecționare a documentelor de arhivă', 'Art. 1. Se numește comisia de selecționare a documentelor în următoarea componență: … Art. 2. Comisia analizează propunerile de eliminare.'],
];

async function* p7(w: World, start: number, idx: number, finish: boolean): Scenario {
  const { as } = w;
  const [type, subject, articles] = DECISIONS[idx % DECISIONS.length]!;
  yield { day: start, hour: 10 };
  const { id } = await as['sef.svf']!.call('POST', '/instances', { definitionKey: 'p7_decisions', title: `Decizie privind ${subject}` });
  await as['sef.svf']!.fields(id, 'draft', { decision_type: type, decision_subject: subject, legal_basis: 'Având în vedere prevederile Legii nr. 315/2004 privind dezvoltarea regională și ale Regulamentului de organizare și funcționare,', articles, effective_date: toIso(dateOf(start + 5)), recipients: 'compartimentele interesate' });
  await as['sef.svf']!.go(id, 'draft', 'submit');
  yield { day: start + 1, hour: 11 };
  // The drafter heads its own unit, so the endorsement goes to the heads-of-unit queue.
  await as['sef.sm']!.go(id, 'head_review', 'endorse');
  yield { day: start + 2, hour: 14 };
  await as.juridic!.fields(id, 'legal_review', { legal_opinion: 'Proiectul de decizie respectă prevederile legale în vigoare. Aviz favorabil pentru legalitate.' });
  await as.juridic!.go(id, 'legal_review', 'favorable');
  if (!finish) return;
  yield { day: start + 3, hour: 16 };
  await as.director!.sign(id, 'decision');
  await as.director!.go(id, 'director_signature', 'sign');
}

/** Runs only the first n segments of a scenario: the dossier then waits at that step. */
async function* limit(gen: Scenario, n: number): Scenario {
  let count = 0;
  while (true) {
    const r = await gen.next();
    if (r.done || count >= n) return;
    count++;
    yield r.value;
  }
}

function dateOf(day: number): Date {
  return new Date(Date.parse(`${simStart}T00:00:00Z`) + day * 86_400_000);
}
let simStart = '2026-05-01';

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

export async function simulate(options: { password: string; days?: number; log?: (m: string) => void }) {
  const log = options.log ?? (() => undefined);
  const realToday = today();
  const days = options.days ?? 150;
  simStart = addDays(realToday, -days);
  const now = new Date();
  const year = Number(realToday.slice(0, 4));
  const cal = new WorkingCalendar({ holidays: [...proposedRomanianHolidays(year - 1), ...proposedRomanianHolidays(year)].map((h) => h.day) });
  const app = await buildApp({ logger: false });
  const r = rng(20261007);
  const usernames = ['registratura', 'evf1', 'evf2', 'ei1', 'achizitii1', 'sef.svf', 'sef.sva', 'sef.sm', 'cfpp', 'director', 'juridic', 'auditor', 'nereguli', 'sef.sn', 'contabil', 'sef.fc', 'admin'];
  const as: Record<string, As> = {};
  for (const u of usernames) as[u] = new As(app, u);

  // The first moment: logins happen "at the start" too.
  let since = (await query(getPool(), `select clock_timestamp() as t`))[0]!.t.toISOString();
  setTodayOverride(simStart);
  for (const u of usernames) await as[u]!.login(options.password);
  await stamp(since, new Date(`${simStart}T07:30:00Z`));

  const projects = (await query(getPool(), `select p.id, p.smis_code, u.username as expert, array_agg(l.code order by l.code) as lines
      from project p join app_user u on u.id = p.responsible_expert_id join project_budget_line l on l.project_id = p.id group by p.id, u.username order by p.smis_code`)).map((p) => ({ id: p.id, smis: p.smis_code, lines: p.lines, expert: p.expert }));
  const suppliers = SUPPLIER_NAMES.map((name, i) => ({ name, cui: withControlDigit(SUPPLIER_BODIES[i]!) }));
  const w: World = {
    as,
    projects,
    rnd: r,
    pick: (xs) => xs[Math.floor(r() * xs.length)]!,
    suppliers,
    sharedInvoice: { cui: suppliers[0]!.cui, no: 'F7788/2026', date: addDays(simStart, 20), amount: '48500.00' },
  };

  const scenarios: Scenario[] = [];
  const span = days - 3;
  const at = (fraction: number) => Math.max(1, Math.floor(span * fraction));
  // P1: 16 dossiers over the period; early ones finished, recent ones in progress.
  const p1Plan: Array<[number, Partial<Parameters<typeof p1>[2]>]> = [
    [0.02, { type: 'rambursare' }], [0.06, { type: 'plata', clarify: true }], [0.1, { type: 'rambursare', doubleCheck: true }],
    [0.16, { type: 'prefinantare' }], [0.22, { type: 'rambursare', returnOnce: true, reuseInvoice: true }], [0.3, { type: 'plata' }],
    [0.38, { type: 'rambursare', clarify: true }], [0.45, { type: 'rambursare', doubleCheck: true }], [0.52, { type: 'plata', returnOnce: true }],
    [0.6, { type: 'rambursare' }], [0.7, { type: 'rambursare', reuseInvoice: true }], [0.78, { type: 'plata', clarify: true }],
    [0.86, { type: 'rambursare' }], [0.92, { type: 'rambursare', doubleCheck: true }], [0.96, { type: 'plata' }], [0.985, { type: 'rambursare' }],
  ];
  p1Plan.forEach(([f, o], i) => scenarios.push(p1(w, at(f), { clarify: false, doubleCheck: false, returnOnce: false, type: 'rambursare', projectIdx: i, ...o })));
  // Dossiers waiting at a given step today (segments run, then they stop): director, heads, experts.
  const waiting: Array<[number, number, Partial<Parameters<typeof p1>[2]>]> = [
    [0.9, 4, { type: 'rambursare' }], [0.91, 4, { type: 'plata' }], [0.93, 4, { type: 'rambursare' }], // at the director (or CFPP)
    [0.92, 3, { type: 'rambursare' }], [0.95, 3, { type: 'prefinantare' }], // at the head of unit
    [0.72, 1, { type: 'rambursare' }], [0.8, 1, { type: 'plata' }], // expert never finished: deadline overdue
    [0.97, 2, { type: 'rambursare', clarify: true }], // waiting for the beneficiary's clarifications
  ];
  waiting.forEach(([f, n, o], i) => scenarios.push(limit(p1(w, at(f), { clarify: false, doubleCheck: false, returnOnce: false, type: 'rambursare', projectIdx: i + 3, ...o }), n)));
  scenarios.push(limit(p2(w, at(0.9), { correction: false, projectIdx: 7 }), 1), limit(p2(w, at(0.96), { correction: true, projectIdx: 8 }), 2));
  [[0.05, true], [0.18, false], [0.33, true], [0.5, false], [0.68, false], [0.84, true], [0.95, false]].forEach(([f, c], i) => scenarios.push(p2(w, at(f as number), { correction: c as boolean, projectIdx: i + 2 })));
  scenarios.push(p4Standalone(w, at(0.4), 3, true), p4Standalone(w, at(0.74), 5, false), p4Standalone(w, at(0.93), 6, true));
  [[0.12, true, false], [0.35, false, false], [0.57, true, true], [0.8, true, false], [0.97, false, false]].forEach(([f, a, rej], i) => scenarios.push(p3(w, at(f as number), { addendum: a as boolean, reject: rej as boolean, projectIdx: i + 1 })));
  const answerers = ['evf2', 'ei1', 'achizitii1', 'evf1', 'nereguli'];
  // Petitions 4, 9 and 12 never got an answer: their legal deadline is overdue today.
  for (let i = 0; i < 14; i++) scenarios.push(p5(w, at(0.03 + i * 0.07), i, answerers[i % answerers.length]!, ![4, 9, 12].includes(i)));
  [[0.08, 'ei1', 3], [0.27, 'evf2', 3], [0.48, 'nereguli', 3], [0.66, 'achizitii1', 2], [0.82, 'evf1', 1], [0.94, 'ei1', 0]].forEach(([f, d, depth]) => scenarios.push(p6(w, at(f as number), d as string, depth as number)));
  [[0.1, 0, true], [0.42, 1, true], [0.63, 2, true], [0.88, 3, true], [0.97, 4, false]].forEach(([f, i, fin]) => scenarios.push(p7(w, at(f as number), i as number, fin as boolean)));

  // Scheduler: run the dossier whose next action is earliest; stop dossiers whose next action is in the future.
  const queue: Array<{ gen: Scenario; when: Date }> = [];
  const moment = (s: Step): Date => {
    let d = toIso(dateOf(s.day));
    while (!cal.isWorkingDay(d)) d = addDays(d, 1);
    const minutes = Math.floor(r() * 50);
    return new Date(`${d}T${String((s.hour ?? 10) - 3).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`); // Bucharest = UTC+3 (summer)
  };
  for (const gen of scenarios) {
    const first = await gen.next();
    if (!first.done) queue.push({ gen, when: moment(first.value) });
  }
  let actions = 0;
  let failures = 0;
  while (queue.length) {
    queue.sort((a, b) => a.when.getTime() - b.when.getTime());
    const item = queue.shift()!;
    if (item.when > now) continue;
    setTodayOverride(item.when.toISOString().slice(0, 10));
    since = (await query(getPool(), `select clock_timestamp() as t`))[0]!.t.toISOString();
    let next: IteratorResult<Step, void>;
    try {
      next = await item.gen.next();
    } catch (e) {
      failures++;
      log(`  ! ${(e as Error).message.slice(0, 300)}`);
      next = { done: true, value: undefined };
    }
    await stamp(since, item.when);
    actions++;
    if (actions % 25 === 0) log(`  ${actions} acțiuni simulate (${item.when.toISOString().slice(0, 10)})`);
    if (!next.done) {
      const when = moment(next.value);
      queue.push({ gen: item.gen, when: when <= item.when ? new Date(item.when.getTime() + 20 * 60_000) : when });
    }
  }

  // Today: the remaining activity of the institution.
  setTodayOverride(null);
  since = (await query(getPool(), `select clock_timestamp() as t`))[0]!.t.toISOString();
  await extras(w, now);
  await scanDeadlines(getPool());
  // Jobs of the simulated past (drafts, e-mails) are not run again by the worker.
  await query(getPool(), `update job_outbox set dispatched_at = coalesce(dispatched_at, created_at), last_error = coalesce(last_error, 'demo: istoric simulat') where dispatched_at is null`);
  // Older notifications are read; the last few days stay unread.
  await query(getPool(), `update notification set read_at = created_at + interval '2 hours' where created_at < now() - interval '4 days'`);
  try {
    await rechainAudit();
  } catch (e) {
    log(`  audit: re-chaining skipped (${(e as Error).message})`);
  }
  await app.close();
  log(`simulare: ${actions} acțiuni, ${failures} eșecuri`);
  return { actions, failures };
}

async function extras(w: World, now: Date) {
  const { as } = w;
  // E-mails waiting in the registry's queue (one answers an existing registration number).
  const lastOut = await query(getPool(), `select e.number_display from register_entry e join register r on r.id = e.register_id where r.key = 'general' and e.direction = 'out' order by e.registered_at desc limit 1`);
  const mails = [
    ['Primăria Exemplu', 'registratura@primaria-exemplu.ro', 'Transmitere documente suplimentare – cererea de rambursare nr. 7', 'Vă transmitem atașat extrasele de cont solicitate.'],
    ['Asociația Transparență Civică', 'contact@transparenta-exemplu.ro', 'Solicitare informații publice – contracte de finanțare semnate', 'În temeiul Legii nr. 544/2001 vă rugăm să ne comunicați lista contractelor de finanțare semnate în anul curent.'],
    ['VEST TECH INOVARE SRL', 'office@vesttech-exemplu.ro', lastOut[0] ? `Răspuns la adresa nr. ${lastOut[0].number_display}` : 'Răspuns la solicitarea de clarificări', 'Atașat transmitem clarificările solicitate.'],
    ['Newsletter Exemplu', 'noreply@newsletter-exemplu.com', 'Oferte speciale la consumabile de birou', 'Promoții valabile săptămâna aceasta.'],
    ['Ministerul Investițiilor și Proiectelor Europene', 'secretariat@mipe-exemplu.ro', 'Instrucțiunea nr. 14/2026 privind verificarea dublei finanțări', 'Vă transmitem instrucțiunea aprobată, aplicabilă de la data primirii.'],
  ];
  for (const [name, from, subject, body] of mails) {
    const raw = Buffer.from(
      `From: ${name} <${from}>\r\nTo: office@adr-demo.ro\r\nSubject: =?UTF-8?B?${Buffer.from(subject!).toString('base64')}?=\r\nDate: ${new Date(now.getTime() - Math.floor(w.rnd() * 3) * 86_400_000).toUTCString()}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@exemplu.ro>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body!).toString('base64')}\r\n--b1\r\nContent-Type: application/pdf; name="anexa.pdf"\r\nContent-Disposition: attachment; filename="anexa.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4\n% demo\n').toString('base64')}\r\n--b1--\r\n`,
    );
    const { storeIncomingMail } = await import('../integrations/mail/intake.js');
    const org = await query(getPool(), `select id from organization order by created_at limit 1`);
    await storeIncomingMail(getPool(), org[0]!.id, raw);
  }
  // Risk-based sampling plan for on-the-spot checks.
  await as.director!.call('POST', '/sampling', { name: 'Verificări la fața locului – trimestrul curent', definitionKey: 'p1_payment_request_check', method: 'risk_weighted', percent: 30, threshold: 60, seed: 'demo-2026-t4' }, true);
  // Substitution: evf1 is on leave this week, evf2 handles the tasks.
  const ids = await query(getPool(), `select id, username from app_user where username in ('evf1', 'evf2')`);
  const id = (u: string) => ids.find((x) => x.username === u)!.id;
  await as.admin!.call('POST', '/substitutions', { absentUserId: id('evf1'), substituteUserId: id('evf2'), scope: 'tasks', validFrom: new Date(now.getTime() + 2 * 86_400_000).toISOString(), validTo: new Date(now.getTime() + 9 * 86_400_000).toISOString() }, true);
  // Finished dossiers are classified in the archive.
  const files = await query(getPool(), `select f.id, n.indicative from archive_file f join archive_nomenclature_item n on n.id = f.nomenclature_item_id where f.year = extract(year from current_date) and f.closed_at is null`);
  const fileOf = (ind: string) => files.find((f) => f.indicative === ind)?.id;
  const done = await query(getPool(), `select i.id, d.key from instance i join process_definition d on d.id = i.definition_id where i.status = 'completed_positive'`);
  const map: Record<string, string> = { p1_payment_request_check: 'FE-3', p2_procurement_check: 'FE-4', p3_addenda: 'FE-5', p4_irregularities: 'FE-6', p5_correspondence: 'I-1', p6_necessity_payment: 'FC-2', p7_decisions: 'C-1' };
  for (const d of done) {
    const f = fileOf(map[d.key] ?? 'I-1');
    if (f) await as.registratura!.call('POST', `/instances/${d.id}/archive`, { archiveFileId: f }, true);
  }
  // An integration token and a webhook, to show the integration screens.
  const tech = await query(getPool(), `select id from app_user where username = 'auditor'`);
  await as.admin!.call('POST', '/admin/api-tokens', { name: 'Power BI – raportare conducere', userId: tech[0]!.id }, true);
}
