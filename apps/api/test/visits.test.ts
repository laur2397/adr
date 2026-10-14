import type { FastifyInstance } from 'fastify';
import PizZip from 'pizzip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../src/core/db.js';
import { getFile } from '../src/documents/storage.js';
import { demoPhoto, demoSignature } from '../src/seed/images.js';
import { imageInfo } from '../src/visits/evidence.js';
import { Client, drainJobs, resetDatabase, startApp, stop } from './helpers.js';

let app: FastifyInstance;
const as: Record<string, Client> = {};
const USERS = ['registratura', 'ei1', 'sef.sm', 'director', 'nereguli', 'evf1', 'auditor'];
const cookies: Record<string, string> = {};

beforeAll(async () => {
  await resetDatabase();
  app = await startApp();
  for (const u of USERS) {
    as[u] = await new Client(app).login(u);
    cookies[u] = (as[u] as unknown as { cookie: string }).cookie;
  }
});
afterAll(async () => stop(app));

const dossier = (c: Client, id: string) => c.ok('GET', `/instances/${id}`);
const value = (d: any, key: string) => d.fields.find((f: any) => f.key === key)?.value;
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
  c.req('POST', `/instances/${id}/transitions`, { taskId: (await task(c, id, step)).id, path, ...extra });

/** Multipart upload the way the field page sends it. */
function upload(user: string, id: string, file: Buffer, meta: Record<string, string>) {
  const boundary = '----flux' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(meta)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return app.inject({
    method: 'POST',
    url: `/api/v1/instances/${id}/evidence`,
    payload: Buffer.concat(parts),
    headers: { cookie: cookies[user]!, 'x-flux-csrf': '1', 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

const projects = async () => (await as.registratura!.ok('GET', '/projects')).items as Array<{ id: string; smis_code: string }>;

describe('demo images', () => {
  it('are valid PNG files with their size readable', () => {
    expect(imageInfo(demoPhoto('building', 3))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    expect(imageInfo(demoSignature(2))).toEqual({ mime: 'image/png', width: 520, height: 200 });
    expect(imageInfo(Buffer.from('not an image'))).toBeNull();
  });
});

/** Answers every item of a checklist that applies to the dossier: DA, unless overridden. */
async function answerAll(c: Client, id: string, step: string, key: string, override: Record<string, { answer: string; observation?: string }> = {}) {
  const t = await task(c, id, step);
  const d = await dossier(c, id);
  const cl = d.checklists.find((x: any) => x.key === key);
  const responses = cl.items.filter((i: any) => i.applies).map((i: any) => ({ code: i.code, answer: override[i.code]?.answer ?? 'DA', observation: override[i.code]?.observation ?? null }));
  await c.ok('PUT', `/instances/${id}/checklists/${key}/responses`, { taskId: t.id, responses });
  return cl;
}
const list = async (c: Client, id: string, step: string, key: string, rows: Record<string, unknown>[]) =>
  c.ok('PUT', `/instances/${id}/lists/${key}`, { taskId: (await task(c, id, step)).id, rows });
const errorsOf = (res: any) => (res.json().errors ?? []).map((e: any) => e.message) as string[];

/** Planning and preparation, up to the visit step (inspector ei1, conflict of interest declared). */
async function toVisit(id: string, planning: Record<string, unknown>) {
  await fields(as.director!, id, 'planning', { visit_scope: 'Verificarea stadiului fizic și a echipamentelor', location: 'Str. Fabricii 12, Iași', ...planning });
  expect((await go(as.director!, id, 'planning', 'schedule')).statusCode).toBe(200);
  await drainJobs();
  await task(as.ei1!, id, 'prepare');
  await as.ei1!.ok('POST', `/instances/${id}/coi`, { hasConflict: false });
  await list(as.ei1!, id, 'prepare', 'team', [{ name: 'Elena Ionescu', role: 'ofiter_monitorizare' }]);
  await fields(as.ei1!, id, 'prepare', { main_risk: 'Echipamentele facturate în CR 3.' });
  await answerAll(as.ei1!, id, 'prepare', 'prepare');
  expect((await go(as.ei1!, id, 'prepare', 'ready')).statusCode).toBe(200);
}

describe('P8 – on-site verification (Anexa 6)', () => {
  let visitId = '';
  let projectId = '';

  it('opens one visit per selected dossier of a sampling plan, once', async () => {
    const all = await projects();
    for (const p of all.slice(0, 3)) await as.registratura!.ok('POST', '/instances', { definitionKey: 'p1_payment_request_check', projectId: p.id });
    const plan = await as.director!.ok('POST', '/sampling', { name: 'Vizite T4', definitionKey: 'p1_payment_request_check', percent: 100, seed: 'test-visits' });
    const first = await as.director!.ok('POST', `/sampling/${plan.id}/visits`);
    expect(first.created).toHaveLength(3);
    const again = await as.director!.ok('POST', `/sampling/${plan.id}/visits`);
    expect(again.created).toHaveLength(0);
    expect(again.alreadyPlanned).toBe(3);
    const detail = await as.director!.ok('GET', `/sampling/${plan.id}`);
    expect(detail.visits).toHaveLength(3);
    visitId = first.created[0].visitId;
    const d = await dossier(as.director!, visitId);
    projectId = d.project.id;
    expect(value(d, 'visit_reason')).toMatch(/^esantion_/);
    expect(value(d, 'sampled_reference')).toContain('Vizite T4');
    expect(value(d, 'notice_documents')).toContain('Originalele contractelor');
    expect(value(d, 'visibility_requirement')).toMatch(/EUR/);
    expect((await as.ei1!.req('POST', `/sampling/${plan.id}/visits`)).statusCode).toBe(403);
  });

  it('schedules with a notice, then the inspector prepares the visit', async () => {
    await fields(as.director!, visitId, 'planning', { planned_date: '2020-01-01', location: 'Str. Fabricii 12, Iași', project_kind: 'echipamente', visit_scope: 'Stadiul fizic și echipamentele din CR 3' });
    const past = await go(as.director!, visitId, 'planning', 'schedule');
    expect(errorsOf(past)).toContain('Data programată nu poate fi în trecut.');
    await fields(as.director!, visitId, 'planning', { planned_date: '2099-03-10', beneficiary_contact: 'Ion Popescu, 0722 000 000' });
    expect((await go(as.director!, visitId, 'planning', 'schedule')).statusCode).toBe(200);
    await drainJobs();
    let d = await dossier(as.ei1!, visitId);
    expect(d.registrations.some((r: any) => r.register_key === 'onsite_visits')).toBe(true);
    expect(d.registrations.some((r: any) => r.register_key === 'general' && r.direction === 'out')).toBe(true);

    await task(as.ei1!, visitId, 'prepare');
    await as.ei1!.ok('POST', `/instances/${visitId}/coi`, { hasConflict: false });
    const early = await go(as.ei1!, visitId, 'prepare', 'ready');
    expect(errorsOf(early)).toEqual(expect.arrayContaining(['Completați câmpul „Echipa de verificare”.', 'Lista de verificare: punctul P.1 nu are răspuns.']));
    d = await dossier(as.ei1!, visitId);
    const prep = d.checklists.find((c: any) => c.key === 'prepare');
    expect(prep.items.find((i: any) => i.code === 'P.2').applies).toBe(true); // announced visit
    expect(prep.items.find((i: any) => i.code === 'P.12').applies).toBe(false); // ex-post only
    await list(as.ei1!, visitId, 'prepare', 'team', [
      { name: 'Elena Ionescu', role: 'ofiter_monitorizare' },
      { name: 'Mihai Pop', role: 'expert_achizitii' },
    ]);
    await list(as.ei1!, visitId, 'prepare', 'equipment', [
      { item: 'Centru de prelucrare CNC', quantity: 1, serial_expected: 'CNC-4471', invoice: 'F 112/2025', placement: 'Hala 1' },
      { item: 'Compresor', quantity: 1, serial_expected: 'KP-0098', invoice: 'F 113/2025', placement: 'Hala 1' },
    ]);
    await fields(as.ei1!, visitId, 'prepare', { main_risk: 'Echipamentele facturate în CR 3.', declared_progress: '70% din activități, conform raportului de progres nr. 4.' });
    await answerAll(as.ei1!, visitId, 'prepare', 'prepare');
    expect((await go(as.ei1!, visitId, 'prepare', 'ready')).statusCode).toBe(200);
    d = await dossier(as.ei1!, visitId);
    expect(d.tasks.find((t: any) => t.stepKey === 'visit' && t.canAct && t.evidence)).toBeTruthy();
  });

  it('accepts photos tagged with a report section, with GPS, only from the inspector, idempotently', async () => {
    expect((await upload('evf1', visitId, demoPhoto('building', 1), { kind: 'photo', clientId: 'x-1' })).statusCode).toBe(404);
    expect((await upload('ei1', visitId, Buffer.from('%PDF-1.4 not an image'), { kind: 'photo', clientId: 'bad-1' })).statusCode).toBe(400);
    const meta = { kind: 'photo', clientId: 'dev-1', caption: 'Hala de producție', section: '2.2 Stadiul activităților', takenAt: '2099-03-10T09:15:00.000Z', latitude: '47.158500', longitude: '27.601400', accuracy: '8' };
    const one = await upload('ei1', visitId, demoPhoto('building', 1), meta);
    expect(one.statusCode).toBe(201);
    expect((await upload('ei1', visitId, demoPhoto('building', 1), meta)).json()).toEqual({ id: one.json().id, duplicate: true });
    expect((await upload('ei1', visitId, demoPhoto('equipment', 2), { kind: 'photo', clientId: 'dev-2', caption: 'Utilaj CNC, seria 4471', section: '2.4 Echipamente' })).statusCode).toBe(201);
    expect((await upload('ei1', visitId, demoSignature(1), { kind: 'signature', clientId: 'sig-1', signerName: 'Ion Popescu' })).statusCode).toBe(201);
    expect((await upload('ei1', visitId, demoSignature(2), { kind: 'signature', clientId: 'sig-2', signerName: 'Ion Popescu' })).statusCode).toBe(201);
    const items = (await as.ei1!.ok('GET', `/instances/${visitId}/evidence`)).items;
    expect(items.filter((e: any) => e.kind === 'photo')).toHaveLength(2);
    expect(items.filter((e: any) => e.kind === 'signature')).toHaveLength(1);
    const photo = items.find((e: any) => e.caption === 'Hala de producție');
    expect(photo.section).toBe('2.2 Stadiul activităților');
    expect(Number(photo.latitude)).toBeCloseTo(47.1585, 4);
    const content = await app.inject({ method: 'GET', url: photo.url, headers: { cookie: cookies.ei1! } });
    expect(content.headers['content-type']).toBe('image/png');
    expect((await as.auditor!.req('GET', `/instances/${visitId}/evidence`)).statusCode).toBe(200);
    expect((await as.evf1!.req('GET', `/instances/${visitId}/evidence`)).statusCode).toBe(404);
  });

  it('shows only the Anexa 6 points that apply and enforces the report rules', async () => {
    const early = await go(as.ei1!, visitId, 'visit', 'submit');
    expect(errorsOf(early)).toEqual(
      expect.arrayContaining([
        'Completați constatarea pentru fiecare echipament din listă (găsit, serie diferită, nefuncțional, lipsă).',
        'Indicați metoda de verificare (integral / eșantion) pentru fiecare document (punctul 13).',
        'Descrieți stadiul activităților față de grafic (punctul 2.2).',
      ]),
    );
    const cl = await answerAll(as.ei1!, visitId, 'visit', 'onsite', { '2.4.2': { answer: 'NU', observation: 'Compresorul are altă serie.' } });
    const applies = (code: string) => cl.items.find((i: any) => i.code === code).applies;
    expect(applies('2.4.1')).toBe(true); // equipment project
    expect(applies('2.5.1')).toBe(false); // no construction works
    expect(applies('EE.1')).toBe(false);
    expect(applies('D.1')).toBe(false); // ex-post only
    expect(cl.items.find((i: any) => i.code === '2.2.1').section).toBe('2.2 Stadiul activităților');

    const d = await dossier(as.ei1!, visitId);
    const docs = value(d, 'documents_checked');
    expect(docs).toHaveLength(7);
    await list(as.ei1!, visitId, 'visit', 'documents_checked', docs.map((r: any, i: number) => ({ ...r, method: i < 3 ? 'integral' : 'esantion' })));
    await list(as.ei1!, visitId, 'visit', 'equipment', [
      { item: 'Centru de prelucrare CNC', quantity: 1, serial_expected: 'CNC-4471', invoice: 'F 112/2025', placement: 'Hala 1', status: 'conform', serial_found: 'CNC-4471' },
      { item: 'Compresor', quantity: 1, serial_expected: 'KP-0098', invoice: 'F 113/2025', placement: 'Hala 1', status: 'serie_diferita', serial_found: 'KP-0102' },
    ]);
    await list(as.ei1!, visitId, 'visit', 'beneficiary_participants', [{ name: 'Ion Popescu', function: 'administrator' }]);
    await fields(as.ei1!, visitId, 'visit', {
      visit_date: '2099-03-10',
      representative: 'Ion Popescu',
      representative_role: 'administrator',
      stage_findings: 'Stadiu fizic estimat 65%, față de 70% declarat.',
      findings: 'Echipamentele există și funcționează; seria compresorului diferă de factură; afișul A3 lipsește.',
      deviation_type: 'intarziere',
      result: 'neconform',
    });
    let res = await go(as.ei1!, visitId, 'visit', 'submit');
    let messages = errorsOf(res);
    expect(messages.some((m) => m.includes('O întârziere nu este, în sine, neregulă'))).toBe(true);
    expect(messages.some((m) => m.includes('un echipament care nu este conform are nevoie de observații'))).toBe(true);
    expect(messages).toContain('Formulați cel puțin o recomandare, cu termen și dovada cerută (punctul 12).');

    await fields(as.ei1!, visitId, 'visit', { result: 'conform_cu_recomandari', escalation_level: 'sprijin' });
    await list(as.ei1!, visitId, 'visit', 'equipment', [
      { item: 'Centru de prelucrare CNC', quantity: 1, serial_expected: 'CNC-4471', status: 'conform', serial_found: 'CNC-4471' },
      { item: 'Compresor', quantity: 1, serial_expected: 'KP-0098', status: 'serie_diferita', serial_found: 'KP-0102', observation: 'Înlocuit în garanție; se cere PV de înlocuire.' },
    ]);
    await list(as.ei1!, visitId, 'visit', 'recommendations', [{ recommendation: 'Montarea afișului A3 la intrarea în hală' }]);
    res = await go(as.ei1!, visitId, 'visit', 'submit');
    expect(errorsOf(res).some((m) => m.includes('fiecare recomandare are text, termen și dovada cerută'))).toBe(true);
    await list(as.ei1!, visitId, 'visit', 'recommendations', [
      { recommendation: 'Montarea afișului A3 la intrarea în hală', deadline: '2099-04-10', evidence_required: 'Fotografie datată, încărcată în MySMIS' },
      { recommendation: 'Procesul-verbal de înlocuire a compresorului', deadline: '2099-04-10', evidence_required: 'PV semnat de furnizor, în MySMIS' },
    ]);
    await as.ei1!.ok('POST', `/instances/${visitId}/documents/visit_report/sign`);
    res = await go(as.ei1!, visitId, 'visit', 'submit');
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

    const doc = (await as.ei1!.ok('GET', `/instances/${visitId}/documents`)).items.find((x: any) => x.key === 'visit_report');
    const [row] = await query(getPool(), `select archival_metadata from document_version where document_id = $1 and archival_metadata ? 'docx' order by version_no desc limit 1`, [doc.id]);
    const zip = new PizZip(await getFile(row!.archival_metadata.docx.storageKey));
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/evidence'))).toHaveLength(3);
    const xml = zip.file('word/document.xml')!.asText();
    const text = xml.replace(/<[^>]+>/g, '');
    expect(text).toContain('RAPORT DE VIZITĂ PE TEREN');
    expect(text).toContain('2.4 Echipamente');
    expect(text).not.toContain('2.5 Lucrări și autorizația de construire');
    expect(text).toContain('Serie diferită');
    expect(text).toContain('Mihai Pop');
    expect(text).toContain('Fotografie datată, încărcată în MySMIS');
    expect(text).toContain('Pe eșantion');
    expect(text).toContain('Foto 1 · 2.4 Echipamente – Utilaj CNC, seria 4471');
    expect(text).toContain('Foto 2 · 2.2 Stadiul activităților – Hala de producție');
    expect(text).toContain('GPS 47.15850, 27.60140 (±8 m)');
    expect(text).toContain('Semnătura reprezentantului beneficiarului: Ion Popescu');
  });

  it('follows the recommendations until each is implemented', async () => {
    expect((await upload('ei1', visitId, demoPhoto('panel', 3), { kind: 'photo', clientId: 'late-1' })).statusCode).toBe(403);
    await as['sef.sm']!.ok('POST', `/instances/${visitId}/documents/visit_report/sign`);
    expect((await go(as['sef.sm']!, visitId, 'head_review', 'endorse')).statusCode).toBe(200);
    await as.director!.ok('POST', `/instances/${visitId}/documents/visit_report/sign`);
    expect((await go(as.director!, visitId, 'director_approval', 'approve')).statusCode).toBe(200);
    await fields(as.ei1!, visitId, 'follow_up', { follow_up_notes: 'Afișul a fost montat; PV-ul compresorului este în curs.' });
    const d = await dossier(as.ei1!, visitId);
    const recs = value(d, 'recommendations');
    await list(as.ei1!, visitId, 'follow_up', 'recommendations', [{ ...recs[0], status: 'implementata' }, { ...recs[1], status: 'partial' }]);
    expect(errorsOf(await go(as.ei1!, visitId, 'follow_up', 'implemented'))).toContain('Toate recomandările trebuie să fie marcate „implementată” (cu dovada încărcată în MySMIS).');
    await list(as.ei1!, visitId, 'follow_up', 'recommendations', [{ ...recs[0], status: 'implementata' }, { ...recs[1], status: 'implementata' }]);
    expect((await go(as.ei1!, visitId, 'follow_up', 'implemented')).json().status).toBe('completed_positive');
    const v = (await as.director!.ok('GET', '/visits')).items.find((x: any) => x.id === visitId);
    expect(v).toMatchObject({ photos: 2, signed: true, result: 'conform_cu_recomandari', result_label: 'Conform, cu recomandări', planned_date: '2099-03-10' });
  });

  it('carries the recommendations and photos into the next visit of the same project', async () => {
    const { id } = await as.director!.ok('POST', '/instances', { definitionKey: 'p8_onsite_verification', projectId });
    // Hidden while planning; the inspector sees it when preparing the visit.
    const rows = await query(getPool(), `select values from instance_list_row where instance_id = $1 and list_key = 'previous_recommendations' order by position`, [id]);
    expect(rows.map((r) => r.values.recommendation)).toEqual(['Montarea afișului A3 la intrarea în hală', 'Procesul-verbal de înlocuire a compresorului']);
    const ctx = await as.director!.ok('GET', `/instances/${id}/visit-context`);
    expect(ctx.previous[0]).toMatchObject({ id: visitId, visit_date: '2099-03-10', result: 'conform_cu_recomandari' });
    expect(ctx.previous[0].photos.map((p: any) => p.section)).toContain('2.4 Echipamente');
  });

  it('goes unannounced on a complaint and refers a suspicion of irregularity', async () => {
    const [p] = await projects();
    const { id } = await as.director!.ok('POST', '/instances', { definitionKey: 'p8_onsite_verification', projectId: p!.id });
    await toVisit(id, { visit_reason: 'suspiciune', project_kind: 'lucrari', planned_date: '2099-05-01' });
    let d = await dossier(as.ei1!, id);
    expect(d.registrations.some((r: any) => r.register_key === 'onsite_visits')).toBe(true);
    expect(d.registrations.some((r: any) => r.register_key === 'general')).toBe(false); // no notice sent
    expect(d.documents?.find?.((x: any) => x.key === 'visit_notice')?.versions?.length ?? 0).toBe(0);
    const cl = await answerAll(as.ei1!, id, 'visit', 'onsite', { '2.1.2': { answer: 'NU', observation: 'Pe șantier lucrează o altă firmă decât cea contractată.' } });
    expect(cl.items.find((i: any) => i.code === '2.5.6').applies).toBe(true);
    const docs = value(await dossier(as.ei1!, id), 'documents_checked');
    await list(as.ei1!, id, 'visit', 'documents_checked', docs.map((r: any) => ({ ...r, method: 'integral' })));
    await list(as.ei1!, id, 'visit', 'beneficiary_participants', [{ name: 'Ana Ionescu', function: 'manager de proiect' }]);
    await list(as.ei1!, id, 'visit', 'works_sampling', [{ position: '3.2', description: 'Zidărie BCA 30 cm', unit: 'mc', qty_paid: '120.00', qty_measured: '96.00' }]);
    d = await dossier(as.ei1!, id);
    expect(value(d, 'works_sampling')[0].difference).toBe(-20);
    await fields(as.ei1!, id, 'visit', {
      visit_date: '2099-05-01',
      representative: 'Ana Ionescu',
      stage_findings: 'Lucrări executate de un subcontractant nedeclarat.',
      findings: 'Pe șantier lucrează o altă firmă; cantitatea de zidărie decontată depășește cu 20% cea măsurată.',
      deviation_type: 'suspiciune_neregula',
      result: 'neconform',
    });
    await list(as.ei1!, id, 'visit', 'recommendations', [{ recommendation: 'Justificarea diferenței de cantități', deadline: '2099-05-20', evidence_required: 'Situație de lucrări refăcută' }]);
    await upload('ei1', id, demoPhoto('equipment', 9), { kind: 'photo', clientId: 'n-1', section: '2.5 Lucrări și autorizația de construire' });
    await upload('ei1', id, demoSignature(5), { kind: 'signature', clientId: 'n-2', signerName: 'Ana Ionescu' });
    await as.ei1!.ok('POST', `/instances/${id}/documents/visit_report/sign`);
    expect((await go(as.ei1!, id, 'visit', 'submit')).statusCode).toBe(200);
    await as['sef.sm']!.ok('POST', `/instances/${id}/documents/visit_report/sign`);
    await go(as['sef.sm']!, id, 'head_review', 'endorse');
    await as.director!.ok('POST', `/instances/${id}/documents/visit_report/sign`);
    expect((await go(as.director!, id, 'director_approval', 'approve')).statusCode).toBe(200);
    d = await dossier(as.director!, id);
    expect(d.children).toHaveLength(1);
    const child = await dossier(as.nereguli!, d.children[0].id);
    expect(value(child, 'source')).toBe('vizita');
    expect(value(child, 'suspicion')).toContain('altă firmă');
  });

  it('checks durability on an ex-post visit', async () => {
    const all = await projects();
    const { id } = await as.director!.ok('POST', '/instances', { definitionKey: 'p8_onsite_verification', projectId: all[2]!.id });
    await toVisit(id, { visit_reason: 'ex_post', project_kind: 'echipamente', planned_date: '2099-06-01' });
    const cl = await answerAll(as.ei1!, id, 'visit', 'onsite');
    expect(cl.items.filter((i: any) => i.applies).map((i: any) => i.code)).toEqual(expect.arrayContaining(['D.1', 'D.8', '5.1', '8.1', 'Z.3']));
    expect(cl.items.find((i: any) => i.code === '2.2.1').applies).toBe(false);
    await fields(as.ei1!, id, 'visit', { visit_date: '2099-06-01', representative: 'Ion Popescu', findings: 'Investiția funcționează.', deviation_type: 'fara_abateri', result: 'conform' });
    const res = await go(as.ei1!, id, 'visit', 'submit');
    const messages = errorsOf(res);
    expect(messages).toContain('Descrieți constatările privind durabilitatea (secțiunea II).');
    expect(messages).not.toContain('Descrieți stadiul activităților față de grafic (punctul 2.2).');
  });
});
