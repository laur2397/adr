import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../src/auth/crypto.js';
import { setTodayOverride } from '../src/core/config.js';
import { getPool, query } from '../src/core/db.js';
import { Client, PASSWORD, drainJobs, resetDatabase, startApp, stop } from './helpers.js';

let app: FastifyInstance;
const as: Record<string, Client> = {};

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  for (const u of ['registratura', 'evf1', 'evf2', 'ei1', 'sef.svf', 'director', 'admin', 'auditor', 'achizitii1', 'sef.sva']) as[u] = await new Client(app).login(u);
});
afterAll(async () => stop(app));
afterEach(() => setTodayOverride(null));

async function dossier(c: Client, id: string) {
  return c.ok('GET', `/instances/${id}`);
}
async function act(c: Client, id: string, path: string, extra: Record<string, unknown> = {}) {
  const task = (await dossier(c, id)).tasks.find((t: { canAct: boolean }) => t.canAct);
  if (!task) throw new Error(`no actionable task (${path})`);
  return c.req('POST', `/instances/${id}/transitions`, { taskId: task.id, path, ...extra });
}
async function setFields(c: Client, id: string, fields: Record<string, unknown>) {
  const task = (await dossier(c, id)).tasks.find((t: { canAct: boolean }) => t.canAct);
  return c.ok('PATCH', `/instances/${id}/fields`, { taskId: task.id, fields });
}
async function startP1(projectSmis: string, submittedAt: string) {
  const p = await as.registratura!.ok('GET', `/projects?q=${projectSmis}`);
  const { id } = await as.registratura!.ok('POST', '/instances', { definitionKey: 'p1_payment_request_check', projectId: p.items[0].id });
  await setFields(as.registratura!, id, { request_no: 'CR-1', request_type: 'plata', submitted_at: submittedAt });
  const res = await act(as.registratura!, id, 'register_and_assign');
  expect(res.statusCode, res.body).toBe(200);
  return id as string;
}

describe('registry (acceptance 7)', () => {
  it('100 simultaneous registrations get 100 unique consecutive numbers', async () => {
    const before = (await as.registratura!.ok('GET', '/registers')).items.find((r: { key: string }) => r.key === 'general').last_number ?? 0;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        as.registratura!.ok('POST', '/registers/general/entries', { direction: 'in', subject: `Adresă ${i}`, sender: { name: `Emitent ${i % 7}`, email: `e${i % 7}@ex.ro` } }),
      ),
    );
    const numbers = results.map((r) => r.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(100);
    expect(numbers[0]).toBe(before + 1);
    expect(numbers[99]).toBe(before + 100);
    // Correspondents were deduplicated by e-mail.
    const senders = await query(getPool(), `select count(*)::int as n from correspondent where email like 'e%@ex.ro'`);
    expect(senders[0]!.n).toBe(7);
  });

  it('only the registry can register; search and XLSX export work', async () => {
    expect((await as.evf1!.req('POST', '/registers/general/entries', { direction: 'in', subject: 'x', sender: { name: 'y' } })).statusCode).toBe(403);
    const found = await as.registratura!.ok('GET', '/registers/general/entries?q=Adresă');
    expect(found.items.length).toBeGreaterThan(0);
    const xlsx = await as.registratura!.req('GET', '/registers/general/entries?format=xlsx');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('deadlines (acceptance 3 and 4.6)', () => {
  it('a 4 working-day suspension moves the deadline by 4 working days', async () => {
    setTodayOverride('2026-10-07');
    const id = await startP1('302877', '2026-10-05');
    let d = await dossier(as.evf2!, id);
    // 20 working days from Mon 5 Oct 2026 -> Mon 2 Nov 2026
    expect(d.deadlines.find((x: { key: string }) => x.key === 'verification').dueOn).toBe('2026-11-02');
    setTodayOverride('2026-10-12');
    await setFields(as.evf2!, id, { clarification_questions: 'Clarificări' });
    expect((await act(as.evf2!, id, 'request_clarifications')).statusCode).toBe(200);
    setTodayOverride('2026-10-16');
    expect((await act(as.evf2!, id, 'answer_received')).statusCode).toBe(200);
    d = await dossier(as.evf2!, id);
    expect(d.deadlines.find((x: { key: string }) => x.key === 'verification')).toMatchObject({ dueOn: '2026-11-06', pauseCount: 1, status: 'running' });
  });

  it('the cap on suspensions blocks a further suspension and notifies the head of unit', async () => {
    await as.admin!.ok('PATCH', '/admin/deadline-definitions/p1_verification', { max_pauses: 1 });
    const id = await startP1('303402', '2026-10-05');
    await setFields(as.evf1!, id, { clarification_questions: 'Prima solicitare' });
    expect((await act(as.evf1!, id, 'request_clarifications')).statusCode).toBe(200);
    expect((await act(as.evf1!, id, 'answer_received')).statusCode).toBe(200);
    const res = await act(as.evf1!, id, 'request_clarifications');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('max_pauses');
    const notes = await as['sef.svf']!.ok('GET', '/notifications');
    expect(notes.items.some((n: { kind: string }) => n.kind === 'deadline_pause_refused')).toBe(true);
    // The refused suspension rolled back the whole transition: the expert still has the task.
    expect((await dossier(as.evf1!, id)).tasks.find((t: { canAct: boolean }) => t.canAct).stepKey).toBe('evf_check');
    // Changing a legal term sends it back to legal validation.
    const defs = await as.admin!.ok('GET', '/admin/deadline-definitions');
    expect(defs.items.find((x: { key: string }) => x.key === 'p1_verification').legal_status).toBe('to_validate');
    await as.admin!.ok('PATCH', '/admin/deadline-definitions/p1_verification', { max_pauses: 10 });
  });
});

describe('substitution during leave', () => {
  it('a substitute acts on the absent colleague\'s tasks; the audit records "on behalf of"', async () => {
    const users = (await as.admin!.ok('GET', '/admin/users')).items;
    const uid = (u: string) => users.find((x: { username: string }) => x.username === u).id;
    await as.admin!.ok('POST', '/substitutions', {
      absentUserId: uid('evf1'),
      substituteUserId: uid('evf2'),
      scope: 'tasks',
      validFrom: new Date(Date.now() - 3600_000).toISOString(),
      validTo: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const id = await startP1('302145', '2026-10-05');
    const evf2 = await new Client(app).login('evf2');
    const d = await dossier(evf2, id);
    const task = d.tasks.find((t: { canAct: boolean }) => t.canAct);
    expect(task).toMatchObject({ stepKey: 'evf_check', onBehalfOf: uid('evf1') });
    await evf2.ok('PATCH', `/instances/${id}/fields`, { taskId: task.id, fields: { clarification_questions: 'Q' } });
    expect((await evf2.req('POST', `/instances/${id}/transitions`, { taskId: task.id, path: 'request_clarifications' })).statusCode).toBe(200);
    const audit = await query(getPool(), `select on_behalf_of_user_id from audit_event where entity_id = $1 and action = 'instance.transition' order by id desc limit 1`, [id]);
    expect(audit[0]!.on_behalf_of_user_id).toBe(uid('evf1'));
    const tasks = await query(getPool(), `select completed_by, on_behalf_of from task where instance_id = $1 and step_key = 'evf_check'`, [id]);
    expect(tasks[0]).toMatchObject({ completed_by: uid('evf2'), on_behalf_of: uid('evf1') });
  });
});

describe('P5 – general correspondence (petition)', () => {
  it('registration > resolution > reply signed > outgoing registration linked to the incoming one', async () => {
    const entry = await as.registratura!.ok('POST', '/registers/general/entries', {
      direction: 'in',
      subject: 'Petiție privind stadiul plăților',
      sender: { name: 'Ion Cetățean', email: 'ion@example.ro' },
      channel: 'email',
      startProcess: { definitionKey: 'p5_correspondence', fields: { category: 'petitie' } },
    });
    const id = entry.instanceId;
    expect((await dossier(as.registratura!, id)).referenceNo).toBe(entry.number_display);
    expect((await act(as.registratura!, id, 'send')).statusCode).toBe(200);
    const d = await dossier(as.director!, id);
    expect(d.deadlines.map((x: { key: string }) => x.key)).toEqual(['petition']);
    const users = (await as.admin!.ok('GET', '/admin/users')).items;
    const evf2 = users.find((x: { username: string }) => x.username === 'evf2').id;
    await setFields(as.director!, id, { resolution: 'Se repartizează doamnei Dumitrescu pentru răspuns.' });
    const missing = await act(as.director!, id, 'assign');
    expect(missing.statusCode).toBe(422); // must choose the assignee
    expect((await act(as.director!, id, 'assign', { assignTo: evf2 })).statusCode).toBe(200);
    await setFields(as.evf2!, id, { reply_summary: 'Plățile au fost efectuate la 30.09.2026.' });
    await as.evf2!.ok('POST', `/instances/${id}/documents/reply_letter/generate`);
    await as.evf2!.ok('POST', `/instances/${id}/documents/reply_letter/sign`);
    expect((await act(as.evf2!, id, 'reply')).statusCode).toBe(200);
    await as['sef.svf']!.ok('POST', `/instances/${id}/documents/reply_letter/sign`);
    const res = await act(as['sef.svf']!, id, 'sign');
    expect(res.json().status).toBe('completed_positive');
    const final = await dossier(as.registratura!, id);
    const out = final.registrations.find((r: { direction: string }) => r.direction === 'out');
    expect(out).toBeTruthy();
    const linked = await query(getPool(), `select related_entry_id, recipient_id from register_entry where id = $1`, [out.id]);
    expect(linked[0]!.related_entry_id).toBe(entry.id);
    expect(linked[0]!.recipient_id).not.toBeNull();
    expect(final.deadlines[0].status).toBe('met');
    await drainJobs();
  });
});

describe('P2 – procurement check', () => {
  it('runs to the procurements register', async () => {
    const p = await as.registratura!.ok('GET', '/projects?q=302145');
    const { id } = await as.registratura!.ok('POST', '/instances', { definitionKey: 'p2_procurement_check', projectId: p.items[0].id });
    await setFields(as.registratura!, id, { procurement_object: 'Linie de producție', procedure_type: 'procedura_simplificata', contract_value: '1.200.000,00', supplier_name: 'Furnizor SRL', supplier_cui: '1590082' });
    expect((await act(as.registratura!, id, 'register')).statusCode).toBe(200);
    const task = (await dossier(as.achizitii1!, id)).tasks.find((t: { canAct: boolean }) => t.canAct);
    expect(task.stepKey).toBe('procurement_check');
    await as.achizitii1!.ok('PUT', `/instances/${id}/checklists/procurement/responses`, {
      taskId: task.id,
      responses: Array.from({ length: 12 }, (_, i) => ({ code: String(i + 1), answer: i === 4 ? 'DA_CU_OBS' : 'DA', observation: i === 4 ? 'Specificații restrictive la lotul 2' : null })),
    });
    const computed = await setFields(as.achizitii1!, id, { findings: 'Specificații restrictive.', verdict: 'aviz_cu_corectie', correction_percent: 5 });
    expect(computed.fields.correction_amount).toBe('60000.00');
    await drainJobs();
    await as.achizitii1!.ok('POST', `/instances/${id}/documents/procurement_note/sign`);
    expect((await act(as.achizitii1!, id, 'submit')).statusCode).toBe(200);
    await as['sef.sva']!.ok('POST', `/instances/${id}/documents/procurement_note/sign`);
    expect((await act(as['sef.sva']!, id, 'endorse')).statusCode).toBe(200);
    await as.director!.ok('POST', `/instances/${id}/documents/procurement_note/sign`);
    expect((await act(as.director!, id, 'approve')).json().status).toBe('completed_positive');
    const regs = (await dossier(as.director!, id)).registrations.map((r: { register_key: string }) => r.register_key);
    expect(regs).toContain('procurements');
  });
});

describe('authentication and access', () => {
  it('rejects wrong passwords, missing CSRF header and anonymous calls', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'evf1', password: 'gresit' }, headers: { 'x-flux-csrf': '1' } });
    expect(bad.statusCode).toBe(401);
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'evf1', password: PASSWORD } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/tasks' })).statusCode).toBe(401);
  });

  it('enables TOTP two-factor authentication', async () => {
    const c = await new Client(app).login('auditor');
    const { secret } = await c.ok('POST', '/me/totp/setup');
    expect((await c.req('POST', '/me/totp/confirm', { secret, code: '000000' })).statusCode).toBe(400);
    await c.ok('POST', '/me/totp/confirm', { secret, code: totpCode(secret) });
    const needs = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'auditor', password: PASSWORD }, headers: { 'x-flux-csrf': '1' } });
    expect(needs.json().code).toBe('totp_required');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'auditor', password: PASSWORD, totp: totpCode(secret) },
      headers: { 'x-flux-csrf': '1' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('users without an explicit right cannot see a dossier or its documents (acceptance 4)', async () => {
    const id = await startP1('302145', '2026-10-05');
    await drainJobs();
    const d = await dossier(as.evf1!, id);
    const version = d.documents.find((x: { key: string }) => x.key === 'verification_note')?.versions[0];
    expect(version).toBeTruthy();
    expect((await as.achizitii1!.req('GET', `/instances/${id}`)).statusCode).toBe(404);
    expect((await as.achizitii1!.req('GET', `/documents/versions/${version.id}/content`)).statusCode).toBe(404);
    const list = await as.achizitii1!.ok('GET', '/instances');
    expect(list.items.some((x: { id: string }) => x.id === id)).toBe(false);
    const download = await as.evf1!.req('GET', `/documents/versions/${version.id}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.headers['x-content-sha256']).toBe(version.sha256);
  });
});

describe('management dashboard and exports', () => {
  it('works with empty filters (as the interface sends them) and refuses non-managers', async () => {
    const d = await as.director!.ok('GET', '/dashboard?from=&to=');
    expect(d.volume.length).toBeGreaterThan(0);
    expect(d.workload.length).toBeGreaterThan(0);
    const filtered = await as.director!.ok('GET', '/dashboard?from=2026-01-01&to=2026-12-31&definition=p1_payment_request_check');
    expect(filtered.deadlines).toBeDefined();
    expect((await as.evf1!.req('GET', '/dashboard')).statusCode).toBe(403);
    const xlsx = await as.director!.req('GET', '/exports/instances.xlsx');
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});
