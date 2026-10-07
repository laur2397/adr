import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../src/core/db.js';
import { Client, drainJobs, resetDatabase, startApp, stop } from './helpers.js';

/**
 * Acceptance criterion 1: a P1 dossier runs end to end (registration > verification >
 * clarifications > endorsement > approval) with generated, signed and registered documents.
 */
describe('P1 – reimbursement request, end to end', () => {
  let app: FastifyInstance;
  let id: string;
  const as: Record<string, Client> = {};

  beforeAll(async () => {
    await resetDatabase();
    app = await startApp();
    for (const u of ['registratura', 'evf1', 'evf2', 'ei1', 'sef.svf', 'director', 'auditor', 'admin']) as[u] = await new Client(app).login(u);
  });
  afterAll(async () => stop(app));

  const dossier = (c: Client) => c.ok('GET', `/instances/${id}`);
  const myTask = async (c: Client) => (await dossier(c)).tasks.find((t: { canAct: boolean }) => t.canAct);
  const go = async (c: Client, path: string, extra: Record<string, unknown> = {}) => {
    const task = await myTask(c);
    expect(task, `no actionable task for path ${path}`).toBeTruthy();
    return c.req('POST', `/instances/${id}/transitions`, { taskId: task.id, path, ...extra });
  };
  const sign = async (c: Client, docKey: string) => c.ok('POST', `/instances/${id}/documents/${docKey}/sign`);
  const generate = async (c: Client, docKey: string) => c.ok('POST', `/instances/${id}/documents/${docKey}/generate`);

  it('registry starts the dossier with prefilled project and beneficiary data', async () => {
    const projects = await as.registratura!.ok('GET', '/projects?q=302145');
    const created = await as.registratura!.ok('POST', '/instances', { definitionKey: 'p1_payment_request_check', projectId: projects.items[0].id });
    id = created.id;
    const d = await dossier(as.registratura!);
    const field = (k: string) => d.fields.find((f: { key: string }) => f.key === k);
    expect(field('smis_code')).toMatchObject({ value: '302145', source: 'project' });
    expect(field('beneficiary_name').value).toBe('EXEMPLU MOBILA SRL');
    expect(field('expenses')).toBeUndefined(); // hidden at registration
    expect(d.tasks[0]).toMatchObject({ stepKey: 'registration', canAct: true });
  });

  it('refuses the registration until required fields are filled, then registers it', async () => {
    const missing = await go(as.registratura!, 'register_and_assign');
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(['request_no', 'request_type', 'submitted_at']));
    const task = await myTask(as.registratura!);
    await as.registratura!.ok('PATCH', `/instances/${id}/fields`, {
      taskId: task.id,
      fields: { request_no: 'CR-7', request_type: 'rambursare', submitted_at: '2026-10-05', double_check: true, beneficiary_iban: 'RO49AAAA1B31007593840000' },
    });
    const res = await go(as.registratura!, 'register_and_assign');
    expect(res.statusCode, res.body).toBe(200);
    const d = await dossier(as.registratura!);
    expect(d.referenceNo).toMatch(/^\d+\/\d{2}\.\d{2}\.\d{4}$/);
    expect(d.deadlines.map((x: { key: string }) => x.key)).toContain('verification');
    expect(d.tasks.map((t: { stepKey: string }) => t.stepKey).sort()).toEqual(['ei_check', 'evf_check']);
  });

  it('assigns EVF to the project expert and hides the dossier from uninvolved users', async () => {
    expect((await myTask(as.evf1!)).stepKey).toBe('evf_check');
    expect((await as.evf2!.req('GET', `/instances/${id}`)).statusCode).toBe(404);
    expect((await as.auditor!.req('GET', `/instances/${id}`)).statusCode).toBe(200);
  });

  it('validates expense lines and computes totals exactly', async () => {
    const task = await myTask(as.evf1!);
    const bad = await as.evf1!.req('PUT', `/instances/${id}/lists/expenses`, { taskId: task.id, rows: [{ budget_line: '1.1', requested: 'abc' }] });
    expect(bad.statusCode).toBe(422);
    const saved = await as.evf1!.ok('PUT', `/instances/${id}/lists/expenses`, {
      taskId: task.id,
      rows: [
        { budget_line: '1.1', document_ref: 'Factura 101/2026', requested: '120.000,10', eligible: '120.000,10' },
        { budget_line: '2.1', document_ref: 'Factura 7/2026', requested: '15000,20', eligible: '14000', reason: 'Depășire tarif de piață' },
      ],
    });
    expect(saved.fields.total_requested).toBe('135000.30');
    expect(saved.fields.total_eligible).toBe('134000.10');
    expect(saved.fields.expenses[1].non_eligible).toBe('1000.20');
  });

  it('requests clarifications: letter generated and registered, deadline suspended, then resumed', async () => {
    const task = await myTask(as.evf1!);
    await as.evf1!.ok('PATCH', `/instances/${id}/fields`, { taskId: task.id, fields: { clarification_questions: 'Transmiteți extrasul de cont pentru factura 7/2026.' } });
    const res = await go(as.evf1!, 'request_clarifications');
    expect(res.statusCode, res.body).toBe(200);
    await drainJobs();
    let d = await dossier(as.evf1!);
    expect(d.deadlines.find((x: { key: string }) => x.key === 'verification')).toMatchObject({ status: 'paused', dueOn: null, pauseCount: 1 });
    expect(d.registrations.filter((r: { direction: string }) => r.direction === 'out')).toHaveLength(1);
    expect(d.documents.find((x: { key: string }) => x.key === 'clarification_letter').versions[0].mime_type).toBe('application/pdf');
    expect((await go(as.evf1!, 'answer_received')).statusCode).toBe(200);
    d = await dossier(as.evf1!);
    expect(d.deadlines.find((x: { key: string }) => x.key === 'verification').status).toBe('running');
    expect(d.tasks.find((t: { canAct: boolean }) => t.canAct).stepKey).toBe('evf_check');
    const inbound = d.registrations.filter((r: { direction: string }) => r.direction === 'in');
    expect(inbound).toHaveLength(2);
  });

  it('EVF cannot submit without checklist, findings and signature', async () => {
    const res = await go(as.evf1!, 'submit');
    expect(res.statusCode).toBe(422);
    const messages = res.json().errors.map((e: { message: string }) => e.message).join('\n');
    expect(messages).toContain('Constatări');
    expect(messages).toContain('Lista de verificare: punctul 1');
    expect(messages).toContain('Semnați documentul');
  });

  it('EVF completes the checklist, signs the generated note and submits', async () => {
    const task = await myTask(as.evf1!);
    await as.evf1!.ok('PATCH', `/instances/${id}/fields`, { taskId: task.id, fields: { findings: 'Cheltuieli verificate; diminuare 1.000,20 lei la linia 2.1.' } });
    const responses = Array.from({ length: 8 }, (_, i) => ({ code: String(i + 1), answer: 'DA' }));
    responses[3] = { code: '4', answer: 'NU', observation: '' } as never;
    const bad = await as.evf1!.req('PUT', `/instances/${id}/checklists/verification/responses`, { taskId: task.id, responses });
    expect(bad.statusCode).toBe(200);
    expect((await go(as.evf1!, 'submit')).json().errors.map((e: { message: string }) => e.message)).toContain(
      'Lista de verificare: punctul 4 (NU) necesită observații.',
    );
    responses[3] = { code: '4', answer: 'DA' };
    await as.evf1!.ok('PUT', `/instances/${id}/checklists/verification/responses`, { taskId: task.id, responses });
    const gen = await generate(as.evf1!, 'verification_note');
    expect(gen.pdf).toBe(true);
    expect((await sign(as.evf1!, 'verification_note')).status).toBe('signed');
    const res = await go(as.evf1!, 'submit');
    expect(res.statusCode, res.body).toBe(200);
    // Join waits for the EI branch.
    const d = await dossier(as.registratura!);
    expect(d.tasks.map((t: { stepKey: string }) => t.stepKey)).toEqual(['ei_check']);
  });

  it('enforces separation of duties on the double check', async () => {
    // Give the EVF expert the EI role too: they still must not complete the second check.
    const users = await as.admin!.ok('GET', '/admin/users');
    const evf1 = users.items.find((u: { username: string }) => u.username === 'evf1');
    await as.admin!.ok('POST', `/admin/users/${evf1.id}/roles`, { roleKey: 'ei_expert' });
    const relogged = await new Client(app).login('evf1');
    const task = (await dossier(relogged)).tasks.find((t: { stepKey: string }) => t.stepKey === 'ei_check');
    await relogged.ok('PUT', `/instances/${id}/checklists/verification/responses`, {
      taskId: task.id,
      responses: Array.from({ length: 8 }, (_, i) => ({ code: String(i + 1), answer: 'DA' })),
    });
    const res = await relogged.req('POST', `/instances/${id}/transitions`, { taskId: task.id, path: 'submit' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('doi experți diferiți');
    const assignment = users.items.find((u: { username: string }) => u.username === 'evf1').roles;
    const added = (await as.admin!.ok('GET', '/admin/users')).items.find((u: { username: string }) => u.username === 'evf1').roles.find(
      (r: { key: string; id: string }) => r.key === 'ei_expert' && !assignment.some((a: { id: string }) => a.id === r.id),
    );
    await as.admin!.ok('DELETE', `/admin/users/${evf1.id}/roles/${added.id}`);
  });

  it('EI claims the queued task and completes the second check; head of unit receives the dossier', async () => {
    const task = (await dossier(as.ei1!)).tasks.find((t: { stepKey: string }) => t.stepKey === 'ei_check');
    await as.ei1!.ok('POST', `/tasks/${task.id}/claim`);
    await as.ei1!.ok('PUT', `/instances/${id}/checklists/verification/responses`, {
      taskId: task.id,
      responses: Array.from({ length: 8 }, (_, i) => ({ code: String(i + 1), answer: 'DA' })),
    });
    expect((await go(as.ei1!, 'submit')).statusCode).toBe(200);
    const head = await myTask(as['sef.svf']!);
    expect(head.stepKey).toBe('head_review');
  });

  it('a return invalidates the signatures given since the target step', async () => {
    const res = await go(as['sef.svf']!, 'return');
    expect(res.statusCode).toBe(422); // comment is mandatory
    expect((await go(as['sef.svf']!, 'return', { comment: 'Atașați PV de recepție la linia 1.1.' })).statusCode).toBe(200);
    const d = await dossier(as.evf1!);
    const note = d.documents.find((x: { key: string }) => x.key === 'verification_note');
    expect(note.signatures.every((s: { status: string }) => s.status === 'invalidated')).toBe(true);
    expect(d.tasks.find((t: { canAct: boolean }) => t.canAct).stepKey).toBe('evf_check');
    // Re-sign and resubmit: the dossier goes straight back to the head of unit (EI branch not reopened).
    await generate(as.evf1!, 'verification_note');
    await sign(as.evf1!, 'verification_note');
    expect((await go(as.evf1!, 'submit')).statusCode).toBe(200);
    expect((await myTask(as['sef.svf']!)).stepKey).toBe('head_review');
  });

  it('head of unit signs and endorses; CFPP is skipped for a reimbursement request', async () => {
    await sign(as['sef.svf']!, 'verification_note');
    expect((await go(as['sef.svf']!, 'endorse')).statusCode).toBe(200);
    await drainJobs(); // authorization notice generated on entering the director step
    expect((await myTask(as.director!)).stepKey).toBe('director_approval');
  });

  it('director signs both documents and approves; registers and budget lines are updated', async () => {
    const before = await query(getPool(), `select code, approved_to_date from project_budget_line l join project p on p.id = l.project_id where p.smis_code = '302145' order by code`);
    const missing = await go(as.director!, 'approve');
    expect(missing.statusCode).toBe(422);
    await sign(as.director!, 'verification_note');
    await sign(as.director!, 'authorization_notice');
    const res = await go(as.director!, 'approve');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('completed_positive');
    const d = await dossier(as.director!);
    expect(d.status).toBe('completed_positive');
    expect(d.deadlines.find((x: { key: string }) => x.key === 'verification').status).toBe('met');
    const registers = d.registrations.map((r: { register_key: string; direction: string }) => `${r.register_key}:${r.direction}`);
    expect(registers).toEqual(expect.arrayContaining(['general:in', 'general:out', 'cr_cp:internal']));
    const note = d.documents.find((x: { key: string }) => x.key === 'verification_note');
    expect(note.signatures.filter((s: { status: string }) => s.status === 'signed').map((s: { signer_name: string }) => s.signer_name)).toEqual([
      'Andrei Ionescu',
      'Cristina Marin',
      'Gabriela Vasile',
    ]);
    const after = await query(getPool(), `select code, approved_to_date from project_budget_line l join project p on p.id = l.project_id where p.smis_code = '302145' order by code`);
    const delta = (code: string) => Number(after.find((r) => r.code === code)!.approved_to_date) - Number(before.find((r) => r.code === code)!.approved_to_date);
    expect(delta('1.1')).toBeCloseTo(120000.1, 2);
    expect(delta('2.1')).toBeCloseTo(14000, 2);
  });

  it('every action is in the audit log and the chain is intact (acceptance 2)', async () => {
    const actions = (await query(getPool(), `select distinct action from audit_event`)).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['instance.create', 'instance.transition', 'instance.return', 'instance.field.update', 'document.generate', 'signature.complete', 'signature.invalidate', 'register.entry.create', 'deadline.pause', 'deadline.resume', 'instance.view', 'task.claim']),
    );
    const verify = await as.auditor!.ok('GET', '/admin/audit/verify');
    expect(verify.intact).toBe(true);
    await expect(query(getPool(), `delete from audit_event`)).rejects.toThrow(/append-only/);
  });

  it('a closed dossier cannot be changed', async () => {
    const res = await as.director!.req('POST', `/instances/${id}/documents/verification_note/generate`);
    expect(res.statusCode).toBe(422);
  });
});
