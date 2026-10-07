import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../src/core/db.js';
import { Client, drainJobs, resetDatabase, startApp, stop } from './helpers.js';

let app: FastifyInstance;
const as: Record<string, Client> = {};
const USERS = ['registratura', 'evf1', 'evf2', 'ei1', 'achizitii1', 'sef.svf', 'sef.sva', 'sef.sm', 'sef.sn', 'cfpp', 'director', 'juridic', 'nereguli', 'contabil', 'admin', 'auditor'];

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  for (const u of USERS) as[u] = await new Client(app).login(u);
});
afterAll(async () => stop(app));

const dossier = (c: Client, id: string) => c.ok('GET', `/instances/${id}`);
async function task(c: Client, id: string, step: string) {
  const d = await dossier(c, id);
  let t = d.tasks.find((x: any) => x.stepKey === step && x.canAct);
  if (t && !t.assignee) {
    await c.ok('POST', `/tasks/${t.id}/claim`);
    t = (await dossier(c, id)).tasks.find((x: any) => x.stepKey === step && x.canAct);
  }
  if (!t) throw new Error(`no task ${step}`);
  return t;
}
const fields = async (c: Client, id: string, step: string, f: Record<string, unknown>) => c.ok('PATCH', `/instances/${id}/fields`, { taskId: (await task(c, id, step)).id, fields: f });
const go = async (c: Client, id: string, step: string, path: string, extra: Record<string, unknown> = {}) =>
  c.ok('POST', `/instances/${id}/transitions`, { taskId: (await task(c, id, step)).id, path, ...extra });
const sign = (c: Client, id: string, doc: string) => c.ok('POST', `/instances/${id}/documents/${doc}/sign`);
const projectId = async (smis: string) => (await as.registratura!.ok('GET', `/projects?q=${smis}`)).items[0].id;

describe('P7 – director decisions', () => {
  it('numbers the decision before signing and keeps the number after a return', async () => {
    const { id } = await as['sef.svf']!.ok('POST', '/instances', { definitionKey: 'p7_decisions', title: 'Decizie comisie evaluare' });
    await fields(as['sef.svf']!, id, 'draft', { decision_type: 'comisie', decision_subject: 'constituirea comisiei', legal_basis: 'Având în vedere…', articles: 'Art. 1. …', recipients: 'SVF' });
    await go(as['sef.svf']!, id, 'draft', 'submit');
    await go(as['sef.sm']!, id, 'head_review', 'endorse');
    await fields(as.juridic!, id, 'legal_review', { legal_opinion: 'Aviz favorabil.' });
    await go(as.juridic!, id, 'legal_review', 'favorable');
    let d = await dossier(as.director!, id);
    const number = d.registrations.find((r: any) => r.register_key === 'decisions').number_display;
    await go(as.director!, id, 'director_signature', 'return', { comment: 'Completați art. 2.' });
    await go(as.juridic!, id, 'legal_review', 'favorable');
    d = await dossier(as.director!, id);
    expect(d.registrations.filter((r: any) => r.register_key === 'decisions')).toHaveLength(1);
    await sign(as.director!, id, 'decision');
    expect((await go(as.director!, id, 'director_signature', 'sign')).status).toBe('completed_positive');
    expect(number).toMatch(/^\d+\//);
  });
});

describe('P6 – necessity report, commitment and payment', () => {
  it('computes VAT exactly, records CFPP visas and the payment order', async () => {
    const { id } = await as.ei1!.ok('POST', '/instances', { definitionKey: 'p6_necessity_payment', title: 'Referat laptopuri' });
    await fields(as.ei1!, id, 'draft', { purpose: 'Laptopuri', justification: 'Necesare', funding_source: 'asistenta_tehnica' });
    const saved = await as.ei1!.ok('PUT', `/instances/${id}/lists/items`, {
      taskId: (await task(as.ei1!, id, 'draft')).id,
      rows: [{ description: 'Laptop', quantity: 3, unit_price: '4.199,99', vat_rate: 21 }],
    });
    expect(saved.fields.items[0].net).toBe('12599.97');
    expect(saved.fields.items[0].vat).toBe('2645.99');
    expect(saved.fields.total).toBe('15245.96');
    await sign(as.ei1!, id, 'necessity_report');
    await go(as.ei1!, id, 'draft', 'submit');
    await sign(as['sef.sm']!, id, 'necessity_report');
    await go(as['sef.sm']!, id, 'head_approval', 'approve');
    await sign(as.cfpp!, id, 'necessity_report');
    await go(as.cfpp!, id, 'cfpp_commitment', 'grant');
    await sign(as.director!, id, 'necessity_report');
    await go(as.director!, id, 'director_commitment', 'approve');
    const over = await as.ei1!.req('POST', `/instances/${id}/transitions`, { taskId: (await task(as.ei1!, id, 'reception')).id, path: 'submit' });
    expect(over.statusCode).toBe(422);
    await fields(as.ei1!, id, 'reception', { supplier_name: 'IT SRL', supplier_cui: '1590082', supplier_iban: 'RO49AAAA1B31007593840000', invoice_no: 'FV 1', invoice_date: '2026-10-01', invoice_amount: '15245,96', reception_note: 'PV 1' });
    await go(as.ei1!, id, 'reception', 'submit');
    await sign(as.contabil!, id, 'payment_authorization');
    await go(as.contabil!, id, 'authorization', 'submit');
    await sign(as.cfpp!, id, 'payment_authorization');
    await go(as.cfpp!, id, 'cfpp_payment', 'grant');
    await sign(as.director!, id, 'payment_authorization');
    await go(as.director!, id, 'director_payment', 'approve');
    await fields(as.contabil!, id, 'payment', { payment_order_no: 'OP 12', payment_date: '2026-10-07' });
    expect((await go(as.contabil!, id, 'payment', 'paid')).status).toBe('completed_positive');
    const regs = (await dossier(as.director!, id)).registrations.map((r: any) => r.register_key);
    expect(regs.filter((r: string) => r === 'cfpp_visas')).toHaveLength(2);
    expect(regs).toEqual(expect.arrayContaining(['necessity_reports', 'payments']));
  });

  it('refuses the CFPP visa to the person who drafted the report', async () => {
    const { id } = await as.cfpp!.ok('POST', '/instances', { definitionKey: 'p6_necessity_payment', title: 'Referat CFPP' });
    await fields(as.cfpp!, id, 'draft', { purpose: 'Toner', justification: 'Necesar', funding_source: 'buget_stat' });
    await as.cfpp!.ok('PUT', `/instances/${id}/lists/items`, { taskId: (await task(as.cfpp!, id, 'draft')).id, rows: [{ description: 'Toner', quantity: 2, unit_price: '300', vat_rate: 21 }] });
    await sign(as.cfpp!, id, 'necessity_report');
    await go(as.cfpp!, id, 'draft', 'submit');
    const t = (await dossier(as.director!, id)).tasks[0];
    // the head of the CFPP department is the drafter: the queue of heads of unit approves
    await sign(as['sef.svf']!, id, 'necessity_report');
    await go(as['sef.svf']!, id, t.stepKey, 'approve');
    await as.cfpp!.req('POST', `/instances/${id}/documents/necessity_report/sign`); // already signed as drafter
    const res = await as.cfpp!.req('POST', `/instances/${id}/transitions`, { taskId: (await task(as.cfpp!, id, 'cfpp_commitment')).id, path: 'grant' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('nu poate acorda viza CFPP');
  });
});

describe('P3 – addendum updates the contract', () => {
  it('extends the project end date after approval', async () => {
    const pid = await projectId('303402');
    const { id } = await as.registratura!.ok('POST', '/instances', { definitionKey: 'p3_addenda', projectId: pid });
    await fields(as.registratura!, id, 'registration', { request_no: '55', request_date: '2026-10-01', kind: 'act_aditional', changes: 'Prelungire 6 luni', new_end_date: '2028-06-30' });
    await go(as.registratura!, id, 'registration', 'register');
    await fields(as.ei1!, id, 'analysis', { analysis: 'Justificat', decision: 'aprobare' });
    await sign(as.ei1!, id, 'analysis_note');
    await go(as.ei1!, id, 'analysis', 'submit');
    await fields(as.juridic!, id, 'legal_review', { legal_opinion: 'Favorabil' });
    await go(as.juridic!, id, 'legal_review', 'favorable');
    await sign(as['sef.sm']!, id, 'analysis_note');
    await go(as['sef.sm']!, id, 'head_review', 'endorse');
    await drainJobs();
    await sign(as.director!, id, 'analysis_note');
    await sign(as.director!, id, 'addendum');
    expect((await go(as.director!, id, 'director_approval', 'approve')).status).toBe('completed_positive');
    const p = await query(getPool(), `select end_date from project where id = $1`, [pid]);
    expect(p[0]!.end_date).toBe('2028-06-30');
  });
});

describe('P2 with financial correction opens P4 (sub-flow); debt ledger', () => {
  let p4: string;
  it('starts an irregularity dossier for the irregularity officer, prefilled from the procurement check', async () => {
    const { id } = await as.registratura!.ok('POST', '/instances', { definitionKey: 'p2_procurement_check', projectId: await projectId('302145') });
    await fields(as.registratura!, id, 'registration', { procurement_object: 'Utilaj', procedure_type: 'licitatie_deschisa', contract_value: '1.000.000', supplier_name: 'X SRL' });
    await go(as.registratura!, id, 'registration', 'register');
    await as.achizitii1!.ok('PUT', `/instances/${id}/checklists/procurement/responses`, {
      taskId: (await task(as.achizitii1!, id, 'procurement_check')).id,
      responses: Array.from({ length: 12 }, (_, i) => ({ code: String(i + 1), answer: 'DA' })),
    });
    await fields(as.achizitii1!, id, 'procurement_check', { findings: 'Specificații restrictive.', verdict: 'aviz_cu_corectie', correction_percent: 10 });
    await sign(as.achizitii1!, id, 'procurement_note');
    await go(as.achizitii1!, id, 'procurement_check', 'submit');
    await sign(as['sef.sva']!, id, 'procurement_note');
    await go(as['sef.sva']!, id, 'head_review', 'endorse');
    await sign(as.director!, id, 'procurement_note');
    await go(as.director!, id, 'director_approval', 'approve');
    const parent = await dossier(as.director!, id);
    expect(parent.children).toHaveLength(1);
    p4 = parent.children[0].id;
    const child = await dossier(as.nereguli!, p4);
    expect(child.parentInstanceId).toBe(id);
    expect(child.fields.find((f: any) => f.key === 'suspicion').value).toBe('Specificații restrictive.');
    expect(child.fields.find((f: any) => f.key === 'affected_amount').value).toBe('100000.00');
    expect(child.tasks[0]).toMatchObject({ stepKey: 'registration', canAct: true });
  });

  it('confirms the irregularity, issues the debt title and records payments', async () => {
    await go(as.nereguli!, p4, 'registration', 'register');
    await fields(as.nereguli!, p4, 'assessment', { irregularity_type: 'achizitii', finding: 'Confirmată', legal_basis: 'OUG 66/2011', debt_principal: '100000', debt_due_date: '2026-12-31', outcome: 'confirmata' });
    await sign(as.nereguli!, p4, 'finding_report');
    await go(as.nereguli!, p4, 'assessment', 'irregularity');
    await sign(as['sef.sn']!, p4, 'finding_report');
    await go(as['sef.sn']!, p4, 'head_review', 'endorse');
    await drainJobs();
    await sign(as.director!, p4, 'finding_report');
    await sign(as.director!, p4, 'debt_title');
    await go(as.director!, p4, 'director_approval', 'approve_debt');
    const debts = await as.contabil!.ok('GET', '/debts');
    const debt = debts.items.find((d: any) => d.instance_id === p4);
    expect(debt).toMatchObject({ principal: '100000.00', balance: '100000.00', status: 'open' });
    expect((await as.contabil!.req('POST', `/debts/${debt.id}/payments`, { amount: '100.000,01', paidOn: '2026-10-07', reference: 'OP 1' })).statusCode).toBe(400);
    await as.contabil!.ok('POST', `/debts/${debt.id}/payments`, { amount: '40.000', paidOn: '2026-10-07', reference: 'OP 1' });
    const after = await as.contabil!.ok('POST', `/debts/${debt.id}/payments`, { amount: '60000', paidOn: '2026-10-08', reference: 'OP 2', kind: 'offset' });
    expect(after).toEqual({ balance: '0.00', status: 'paid' });
    expect((await as.evf1!.req('GET', '/debts')).statusCode).toBe(403);
    const irr = await as.director!.ok('GET', '/irregularities');
    expect(irr.items.find((i: any) => i.id === p4).ims_reportable).toBe(true);
  });
});

describe('conflict of interest, double funding, comments, search', () => {
  let a: string;
  let b: string;
  async function p1WithInvoice(smis: string, invoice: string) {
    const { id } = await as.registratura!.ok('POST', '/instances', { definitionKey: 'p1_payment_request_check', projectId: await projectId(smis) });
    await fields(as.registratura!, id, 'registration', { request_no: 'CR', request_type: 'rambursare', submitted_at: '2026-10-01' });
    await go(as.registratura!, id, 'registration', 'register_and_assign');
    return id;
  }

  it('requires a conflict-of-interest declaration before the verifier can work', async () => {
    a = await p1WithInvoice('302145', 'F-0012/2026');
    as.evf1!.autoCoi = false;
    const t = (await dossier(as.evf1!, a)).tasks.find((x: any) => x.canAct);
    const res = await as.evf1!.req('PATCH', `/instances/${a}/fields`, { taskId: t.id, fields: { findings: 'x' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('coi_required');
    expect((await dossier(as.evf1!, a)).coi).toMatchObject({ required: true, declared: false });
    await as.evf1!.ok('POST', `/instances/${a}/coi`, { hasConflict: false });
    as.evf1!.autoCoi = true;
    expect((await as.evf1!.req('PATCH', `/instances/${a}/fields`, { taskId: t.id, fields: { findings: 'x' } })).statusCode).toBe(200);
  });

  it('flags the same invoice claimed in another project (normalized number)', async () => {
    const row = (no: string) => ({ budget_line: '1.1', document_ref: 'Factura', supplier_cui: 'RO1590082', invoice_no: no, invoice_date: '2026-09-01', requested: '1000', eligible: '1000' });
    await as.evf1!.ok('PUT', `/instances/${a}/lists/expenses`, { taskId: (await task(as.evf1!, a, 'evf_check')).id, rows: [row('F-0012/2026')] });
    b = await p1WithInvoice('302877', 'F 12 / 2026');
    await as.evf2!.ok('PUT', `/instances/${b}/lists/expenses`, { taskId: (await task(as.evf2!, b, 'evf_check')).id, rows: [row('f 12/2026')] });
    const alerts = (await dossier(as.evf2!, b)).doubleFunding;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ otherInstanceId: a, sameProject: false });
  });

  it('a declared conflict releases the task to the queue and notifies the head of unit', async () => {
    await as.evf2!.ok('POST', `/instances/${b}/coi`, { hasConflict: true, details: 'Rudă de gradul II cu administratorul beneficiarului.' });
    const d = await dossier(as.director!, b);
    expect(d.tasks[0].assignee).toBeNull();
    const notes = await as['sef.svf']!.ok('GET', '/notifications');
    expect(notes.items.some((n: any) => n.kind === 'coi_declared')).toBe(true);
    as.evf2!.autoCoi = false;
    const t = (await dossier(as.evf2!, b)).tasks[0];
    expect((await as.evf2!.req('POST', `/tasks/${t.id}/claim`)).statusCode).toBe(403);
    as.evf2!.autoCoi = true;
  });

  it('comments with mentions notify and give read access; search finds them', async () => {
    expect((await as.achizitii1!.req('GET', `/instances/${a}`)).statusCode).toBe(404);
    const r = await as.evf1!.ok('POST', `/instances/${a}/comments`, { body: '@achizitii1 te rog verifică procedura pentru factura F-0012 (furnizor unic).' });
    expect(r.mentioned).toEqual(['Elena Stan']);
    expect((await as.achizitii1!.req('GET', `/instances/${a}`)).statusCode).toBe(200);
    const found = await as.achizitii1!.ok('GET', `/search?q=${encodeURIComponent('furnizor unic')}`);
    expect(found.instances.map((i: any) => i.id)).toContain(a);
    const notFound = await as.ei1!.ok('GET', `/search?q=${encodeURIComponent('furnizor unic')}`);
    expect(notFound.instances.map((i: any) => i.id)).not.toContain(a);
  });
});

describe('risk-based sampling', () => {
  it('is reproducible from the stored seed and audited', async () => {
    const body = { name: 'T', definitionKey: 'p1_payment_request_check', percent: 50, threshold: 101, seed: 'abc' };
    const one = await as.director!.ok('POST', '/sampling', { ...body, preview: true });
    const two = await as.director!.ok('POST', '/sampling', { ...body, preview: true });
    const sel = (r: any) => r.items.filter((i: any) => i.selected).map((i: any) => i.instanceId).sort();
    expect(sel(one)).toEqual(sel(two));
    expect(sel(one).length).toBe(Math.ceil(one.populationSize / 2));
    const saved = await as.director!.ok('POST', '/sampling', body);
    const plan = await as.director!.ok('GET', `/sampling/${saved.id}`);
    expect(plan.seed).toBe('abc');
    expect((await as.evf1!.req('GET', '/sampling')).statusCode).toBe(403);
    const audited = await query(getPool(), `select new_value from audit_event where action = 'sampling.create'`);
    expect(audited[0]!.new_value.seed).toBe('abc');
  });
});

describe('archive', () => {
  it('classifies, closes, exports the inventory and refuses early disposal', async () => {
    // the functional administrator sees every dossier (supervisor access)
    const arch = await as.admin!.ok('GET', '/archive');
    const fe3 = arch.items.find((i: any) => i.indicative === 'FE-3');
    const current = fe3.files.find((f: any) => f.year === arch.year);
    const done = await query(getPool(), `select id from instance where status = 'completed_positive' limit 1`);
    await as.admin!.ok('POST', `/instances/${done[0]!.id}/archive`, { archiveFileId: current.id });
    const file = await as.admin!.ok('GET', `/archive/files/${current.id}`);
    expect(file.documents.length).toBeGreaterThan(0);
    const xlsx = await as.registratura!.req('GET', `/archive/files/${current.id}?format=xlsx`);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect((await as.director!.req('POST', `/archive/files/${current.id}/dispose`, { decision: 'x' })).statusCode).toBe(409);
    await as.registratura!.ok('POST', `/archive/files/${current.id}/close`);
    expect((await as.admin!.req('POST', `/instances/${done[0]!.id}/archive`, { archiveFileId: current.id })).statusCode).toBe(400);
    const disposal = await as.director!.ok('GET', '/archive/disposal');
    const old = disposal.items.find((d: any) => d.indicative === 'FE-3');
    expect(old).toBeTruthy();
    await as.director!.ok('POST', `/archive/files/${old.id}/dispose`, { decision: 'PV comisie nr. 3/2026, aviz SJAN nr. 77' });
  });
});

describe('integrations', () => {
  it('API tokens authenticate without cookies and can be revoked', async () => {
    const users = (await as.admin!.ok('GET', '/admin/users')).items;
    const auditor = users.find((u: any) => u.username === 'auditor');
    const { id, token } = await as.admin!.ok('POST', '/admin/api-tokens', { name: 'BI', userId: auditor.id });
    const res = await app.inject({ method: 'GET', url: '/api/v1/instances', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
    await as.admin!.ok('DELETE', `/admin/api-tokens/${id}`);
    expect((await app.inject({ method: 'GET', url: '/api/v1/instances', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it('webhooks queue a delivery for subscribed events', async () => {
    await as.admin!.ok('POST', '/admin/webhooks', { name: 'ERP', url: 'https://erp.example.ro/hook', events: ['registry.entry_created'] });
    await as.registratura!.ok('POST', '/registers/general/entries', { direction: 'in', subject: 'Adresă', sender: { name: 'X' } });
    const jobs = await query(getPool(), `select payload from job_outbox where kind = 'webhook'`);
    expect(jobs.some((j) => j.payload.event === 'registry.entry_created')).toBe(true);
  });

  it('e-mail intake: queued, suggested dossier from the number in the subject, attached on confirmation', async () => {
    const entry = await as.registratura!.ok('POST', '/registers/general/entries', {
      direction: 'in', subject: 'Cerere', sender: { name: 'Ion', email: 'ion@ex.ro' }, startProcess: { definitionKey: 'p5_correspondence', fields: { category: 'corespondenta' } },
    });
    const eml = Buffer.from(
      `From: Ion <ion@ex.ro>\r\nTo: office@adr.ro\r\nSubject: Re: nr. ${entry.number_display}\r\nMessage-ID: <m1@ex.ro>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCompletare.\r\n--b\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('%PDF-1.4').toString('base64')}\r\n--b--\r\n`,
    );
    const boundary = '----flux';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="m.eml"\r\nContent-Type: message/rfc822\r\n\r\n`),
      eml,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/mail/upload',
      payload,
      headers: { cookie: (as.registratura as any).cookie, 'x-flux-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(up.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: '/api/v1/mail/upload', payload, headers: { cookie: (as.registratura as any).cookie, 'x-flux-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(again.json().duplicate).toBe(true);
    const list = await as.registratura!.ok('GET', '/mail?status=pending');
    const m = list.items[0];
    expect(m.suggested_instance_id).toBe(entry.instanceId);
    expect(m.attachments).toBe(1);
    const r = await as.registratura!.ok('POST', `/mail/${m.id}/process`, { action: 'attach', instanceId: entry.instanceId });
    expect(r.status).toBe('attached');
    const d = await dossier(as.registratura!, entry.instanceId);
    expect(d.documents.map((x: any) => x.type)).toEqual(expect.arrayContaining(['email', 'email_attachment']));
    expect(d.registrations.filter((x: any) => x.direction === 'in')).toHaveLength(2);
  });

  it('keeps the audit chain intact', async () => {
    expect((await as.auditor!.ok('GET', '/admin/audit/verify')).intact).toBe(true);
  });
});
