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

describe('P8 – on-site verification', () => {
  let visitId = '';

  it('opens one visit per selected dossier of a sampling plan, once', async () => {
    const list = await projects();
    for (const p of list.slice(0, 3)) await as.registratura!.ok('POST', '/instances', { definitionKey: 'p1_payment_request_check', projectId: p.id });
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
    expect(value(d, 'visit_reason')).toMatch(/^esantion_/);
    expect(value(d, 'sampled_reference')).toContain('Vizite T4');
    // Experts cannot create visits from a plan.
    expect((await as.ei1!.req('POST', `/sampling/${plan.id}/visits`)).statusCode).toBe(403);
  });

  it('schedules the visit and sends the notice to the beneficiary', async () => {
    const past = await (async () => {
      await fields(as.director!, visitId, 'planning', { planned_date: '2020-01-01', location: 'Str. Fabricii 12, Iași' });
      return go(as.director!, visitId, 'planning', 'schedule');
    })();
    expect(past.statusCode).toBe(422);
    expect(past.json().errors.map((e: any) => e.message)).toContain('Data programată nu poate fi în trecut.');
    await fields(as.director!, visitId, 'planning', { planned_date: '2099-03-10', beneficiary_contact: 'Ion Popescu, 0722 000 000' });
    expect((await go(as.director!, visitId, 'planning', 'schedule')).statusCode).toBe(200);
    await drainJobs();
    const d = await dossier(as.ei1!, visitId);
    expect(d.registrations.some((r: any) => r.register_key === 'onsite_visits')).toBe(true);
    expect(d.registrations.some((r: any) => r.register_key === 'general' && r.direction === 'out')).toBe(true);
    const docs = await as.ei1!.ok('GET', `/instances/${visitId}/documents`);
    expect(docs.items.find((x: any) => x.key === 'visit_notice').versions.length).toBeGreaterThan(0);
  });

  it('accepts photos with GPS and the signature only from the inspector, idempotently', async () => {
    await task(as.ei1!, visitId, 'visit'); // claims the queue task (and declares no conflict of interest)
    await as.ei1!.ok('POST', `/instances/${visitId}/coi`, { hasConflict: false });
    expect((await upload('evf1', visitId, demoPhoto('building', 1), { kind: 'photo', clientId: 'x-1' })).statusCode).toBe(404);
    const bad = await upload('ei1', visitId, Buffer.from('%PDF-1.4 not an image'), { kind: 'photo', clientId: 'bad-1' });
    expect(bad.statusCode).toBe(400);
    const meta = { kind: 'photo', clientId: 'dev-1', caption: 'Hala de producție', takenAt: '2099-03-10T09:15:00.000Z', latitude: '47.158500', longitude: '27.601400', accuracy: '8' };
    const one = await upload('ei1', visitId, demoPhoto('building', 1), meta);
    expect(one.statusCode).toBe(201);
    const resent = await upload('ei1', visitId, demoPhoto('building', 1), meta);
    expect(resent.json()).toEqual({ id: one.json().id, duplicate: true });
    expect((await upload('ei1', visitId, demoPhoto('equipment', 2), { kind: 'photo', clientId: 'dev-2', caption: 'Utilaj CNC, seria 4471' })).statusCode).toBe(201);
    expect((await upload('ei1', visitId, demoSignature(1), { kind: 'signature', clientId: 'sig-1', signerName: 'Ion Popescu' })).statusCode).toBe(201);
    expect((await upload('ei1', visitId, demoSignature(2), { kind: 'signature', clientId: 'sig-2', signerName: 'Ion Popescu' })).statusCode).toBe(201);
    const list = await as.ei1!.ok('GET', `/instances/${visitId}/evidence`);
    expect(list.items.filter((e: any) => e.kind === 'photo')).toHaveLength(2);
    expect(list.items.filter((e: any) => e.kind === 'signature')).toHaveLength(1); // the second replaced the first
    const photo = list.items.find((e: any) => e.caption === 'Hala de producție');
    expect(Number(photo.latitude)).toBeCloseTo(47.1585, 4);
    const content = await app.inject({ method: 'GET', url: photo.url, headers: { cookie: cookies.ei1! } });
    expect(content.headers['content-type']).toBe('image/png');
    // Auditors (supervisors) can see the evidence; experts outside the dossier cannot.
    expect((await as.auditor!.req('GET', `/instances/${visitId}/evidence`)).statusCode).toBe(200);
    expect((await as.evf1!.req('GET', `/instances/${visitId}/evidence`)).statusCode).toBe(404);
  });

  it('requires the checklist, the findings and the signed report, with the photo annex in the report', async () => {
    const early = await go(as.ei1!, visitId, 'visit', 'submit');
    expect(early.statusCode).toBe(422);
    const t = await task(as.ei1!, visitId, 'visit');
    const responses = Array.from({ length: 12 }, (_, i) => ({ code: String(i + 1), answer: 'DA', observation: null }));
    await as.ei1!.ok('PUT', `/instances/${visitId}/checklists/onsite/responses`, { taskId: t.id, responses });
    await fields(as.ei1!, visitId, 'visit', {
      visit_date: '2099-03-10',
      representative: 'Ion Popescu',
      representative_role: 'administrator',
      findings: 'Echipamentele sunt instalate și funcționale; panoul de informare lipsește.',
      result: 'conform_cu_recomandari',
    });
    const noRecs = await go(as.ei1!, visitId, 'visit', 'submit');
    const messages = noRecs.json().errors.map((e: any) => e.message);
    expect(messages).toContain('Formulați recomandările către beneficiar.');
    expect(messages).toContain('Stabiliți termenul de implementare a recomandărilor.');
    await fields(as.ei1!, visitId, 'visit', { recommendations: 'Montarea panoului de informare.', recommendations_deadline: '2099-04-10' });
    await as.ei1!.ok('POST', `/instances/${visitId}/documents/visit_report/sign`);
    expect((await go(as.ei1!, visitId, 'visit', 'submit')).statusCode).toBe(200);

    const doc = (await as.ei1!.ok('GET', `/instances/${visitId}/documents`)).items.find((x: any) => x.key === 'visit_report');
    const [row] = await query(
      getPool(),
      `select archival_metadata from document_version where document_id = $1 and archival_metadata ? 'docx' order by version_no desc limit 1`,
      [doc.id],
    );
    const docx = await getFile(row!.archival_metadata.docx.storageKey);
    const zip = new PizZip(docx);
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/evidence'))).toHaveLength(3);
    const xml = zip.file('word/document.xml')!.asText();
    expect(xml).toContain('Hala de producție');
    expect(xml).toContain('GPS 47.15850, 27.60140 (±8 m)');
    expect(xml).toContain('Semnătura reprezentantului beneficiarului: Ion Popescu');
  });

  it('closes the evidence once the visit step is over and follows the recommendations', async () => {
    expect((await upload('ei1', visitId, demoPhoto('panel', 3), { kind: 'photo', clientId: 'late-1' })).statusCode).toBe(403);
    await as['sef.sm']!.ok('POST', `/instances/${visitId}/documents/visit_report/sign`);
    expect((await go(as['sef.sm']!, visitId, 'head_review', 'endorse')).statusCode).toBe(200);
    await as.director!.ok('POST', `/instances/${visitId}/documents/visit_report/sign`);
    expect((await go(as.director!, visitId, 'director_approval', 'approve')).statusCode).toBe(200);
    let d = await dossier(as.ei1!, visitId);
    expect(d.tasks.find((t: any) => t.stepKey === 'follow_up' && t.canAct)).toBeTruthy();
    await fields(as.ei1!, visitId, 'follow_up', { follow_up_notes: 'Beneficiarul a transmis fotografii cu panoul montat.' });
    const res = await go(as.ei1!, visitId, 'follow_up', 'implemented');
    expect(res.json().status).toBe('completed_positive');
    const visits = await as.director!.ok('GET', '/visits');
    const v = visits.items.find((x: any) => x.id === visitId);
    expect(v).toMatchObject({ photos: 2, signed: true, result: 'conform_cu_recomandari', result_label: 'Conform, cu recomandări', planned_date: '2099-03-10' });
    d = await dossier(as.director!, visitId);
    expect(d.status).toBe('completed_positive');
  });

  it('reports an irregularity when the visit finds the operation non-compliant', async () => {
    const [p] = await projects();
    const { id } = await as.director!.ok('POST', '/instances', { definitionKey: 'p8_onsite_verification', projectId: p!.id });
    await fields(as.director!, id, 'planning', { visit_reason: 'suspiciune', planned_date: '2099-05-01', location: 'Sediul beneficiarului' });
    await go(as.director!, id, 'planning', 'schedule');
    await drainJobs();
    await task(as.ei1!, id, 'visit');
    const t = await task(as.ei1!, id, 'visit');
    await as.ei1!.ok('PUT', `/instances/${id}/checklists/onsite/responses`, {
      taskId: t.id,
      responses: Array.from({ length: 12 }, (_, i) => ({ code: String(i + 1), answer: i === 1 ? 'NU' : 'DA', observation: i === 1 ? 'Echipamentul nu se află la locație.' : null })),
    });
    await fields(as.ei1!, id, 'visit', { visit_date: '2099-05-01', representative: 'Ana Ionescu', findings: 'Utilajul decontat nu se află la locația declarată.', result: 'neconform', recommendations: 'Prezentarea utilajului.' });
    await upload('ei1', id, demoPhoto('equipment', 9), { kind: 'photo', clientId: 'n-1' });
    await upload('ei1', id, demoSignature(5), { kind: 'signature', clientId: 'n-2', signerName: 'Ana Ionescu' });
    await as.ei1!.ok('POST', `/instances/${id}/documents/visit_report/sign`);
    await go(as.ei1!, id, 'visit', 'submit');
    await as['sef.sm']!.ok('POST', `/instances/${id}/documents/visit_report/sign`);
    await go(as['sef.sm']!, id, 'head_review', 'endorse');
    await as.director!.ok('POST', `/instances/${id}/documents/visit_report/sign`);
    const res = await go(as.director!, id, 'director_approval', 'approve');
    expect(res.statusCode).toBe(200);
    const d = await dossier(as.director!, id);
    expect(d.children).toHaveLength(1);
    const child = await dossier(as.nereguli!, d.children[0].id);
    expect(value(child, 'source')).toBe('vizita');
    expect(value(child, 'suspicion')).toContain('Utilajul decontat');
  });
});
