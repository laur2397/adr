import { devices, expect, test, type Page } from '@playwright/test';
import { demoPhoto } from '../../apps/api/src/seed/images';

/**
 * On-site verification v2 on a phone (Anexa 6): the officer prepares the visit (team, equipment,
 * prepare checklist), then works on the device without signal — the Anexa 6 sections, findings,
 * photos tagged by section with GPS, and the representative's signature — reopens the page offline,
 * and when the signal returns the report is signed and submitted.
 */
const PASSWORD = 'Parola-e2e-2026';

async function login(page: Page, username: string) {
  await page.goto('/');
  await page.getByLabel('Utilizator').fill(username);
  await page.getByLabel('Parolă').fill(PASSWORD);
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page.getByRole('heading', { name: /Bună ziua/ })).toBeVisible();
}

const api = (page: Page, method: string, url: string, body?: unknown) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(`/api/v1${u}`, { method: m as string, headers: { 'x-flux-csrf': '1', ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text();
      if (!r.ok) throw new Error(`${m} ${u}: ${r.status} ${t}`);
      return t ? JSON.parse(t) : null;
    },
    [method, url, body] as const,
  );

test('field visit v2: prepare, verify by sections offline, synced and submitted', async ({ browser }) => {
  // Head of the monitoring unit opens and schedules a visit (through the API; the UI is covered elsewhere).
  const desk = await (await browser.newContext()).newPage();
  await login(desk, 'sef.sm');
  const project = (await api(desk, 'GET', '/projects')).items[0];
  const { id } = await api(desk, 'POST', '/instances', { definitionKey: 'p8_onsite_verification', projectId: project.id });
  const planning = (await api(desk, 'GET', `/instances/${id}`)).tasks.find((t: any) => t.canAct);
  await api(desk, 'PATCH', `/instances/${id}/fields`, {
    taskId: planning.id,
    fields: { visit_reason: 'monitorizare', project_kind: 'echipamente', visit_scope: 'Echipamente', planned_date: '2099-01-15', location: 'Str. Fabricii 12, Iași' },
  });
  await api(desk, 'POST', `/instances/${id}/transitions`, { taskId: planning.id, path: 'schedule' });

  const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: 47.1585, longitude: 27.6014, accuracy: 6 }, permissions: ['geolocation'] });
  const phone = await ctx.newPage();
  await login(phone, 'ei1');
  await phone.goto(`/teren/${id}`);

  // PREGĂTESC: claim (with the conflict-of-interest declaration), fill the team, answer the prepare list.
  await phone.getByRole('button', { name: 'Completează declarația' }).click();
  await phone.getByRole('dialog').getByRole('button', { name: 'Semnez declarația' }).click();
  await phone.getByRole('button', { name: 'Preiau vizita' }).click();
  await expect(phone.getByRole('button', { name: 'Preiau vizita' })).toBeHidden();
  await phone.getByRole('button', { name: 'Membru în echipă' }).click();
  await phone.getByLabel('Nume și prenume, rândul 1').fill('Elena Ionescu');
  await phone.getByLabel('Calitatea, rândul 1').selectOption('ofiter_monitorizare');
  await phone.getByLabel(/Unde este riscul/).fill('Seriile echipamentelor.');
  const prepItems = await phone.locator('[aria-label^="Răspuns la punctul P."]').count();
  for (let i = 0; i < prepItems; i++) await phone.locator('[aria-label^="Răspuns la punctul P."]').nth(i).getByRole('button', { name: 'Da', exact: true }).click();
  await phone.getByRole('button', { name: /Pregătirea este completă/ }).click();
  await expect(phone.getByText(/Dosarul este pe acest dispozitiv/)).toBeVisible();
  await expect(phone.getByText(/Poziția dvs\.: 47\.15850, 27\.60140/)).toBeVisible();

  // VERIFIC, offline: opening data, a report section, a photo and the signature.
  await ctx.setOffline(true);
  await phone.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(phone.locator('.net.off')).toBeVisible();
  await phone.getByLabel(/Reprezentantul beneficiarului care semnează/).fill('Ion Popescu');
  await phone.getByRole('button', { name: 'Participant' }).click();
  await phone.getByLabel('Nume și prenume, rândul 1').fill('Ion Popescu');

  // Open every section, answer all applicable points (DA) and write the 2.2 section finding.
  await phone.getByRole('button', { name: 'Deschide toate secțiunile' }).click();
  const all = phone.locator('[aria-label^="Răspuns la punctul "]');
  for (let i = 0; i < (await all.count()); i++) await all.nth(i).getByRole('button', { name: 'Da', exact: true }).click();
  // Fill every section finding (so 2.2 "Stadiul activităților", required for submission, is covered).
  const notes = phone.getByLabel('Constatări la această secțiune');
  for (let i = 0; i < (await notes.count()); i++) await notes.nth(i).fill('Constatări conforme.');

  // A photo tagged with a report section.
  await phone.getByLabel('Descrierea fotografiei').fill('Hala de producție');
  await phone.getByLabel('Secțiunea raportului').selectOption('2.2 Stadiul activităților');
  await phone.locator('input[type=file][capture]').setInputFiles({ name: 'hala.png', mimeType: 'image/png', buffer: demoPhoto('building', 1) });
  await expect(phone.getByText('Fotografie salvată pe dispozitiv.')).toBeVisible();

  // RAPORTEZ: documents method, findings, result, a recommendation and the signature.
  await phone.getByRole('button', { name: '3 · Raportez' }).click();
  const methods = phone.locator('[aria-label^="Metoda, rândul "]');
  for (let i = 0; i < (await methods.count()); i++) await methods.nth(i).getByRole('button', { name: /Integral|eșantion/ }).first().click();
  await phone.getByLabel(/Concluzii/).fill('Echipamentele există și funcționează; afișul lipsește.');
  await phone.getByLabel(/Natura abaterilor/).selectOption('abatere_procedurala');
  await phone.getByLabel(/Rezultatul verificării/).selectOption('conform_cu_recomandari');
  await phone.getByRole('button', { name: 'Recomandare' }).click();
  await phone.getByLabel('Recomandarea, rândul 1').fill('Montarea afișului A3');
  await phone.getByLabel('Termen, rândul 1').fill('2099-02-15');
  await phone.getByLabel('Dovada cerută, rândul 1').fill('Fotografie în MySMIS');

  const pad = phone.locator('canvas.signature-pad');
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await phone.mouse.move(box.x + 20, box.y + 100);
  await phone.mouse.down();
  for (let t = 0; t < 40; t++) await phone.mouse.move(box.x + 20 + t * 6, box.y + 100 - Math.sin(t / 3) * 40);
  await phone.mouse.up();
  await phone.getByRole('button', { name: 'Salvează semnătura' }).click();
  await expect(phone.getByText(/modificări pe dispozitiv/)).toBeVisible();

  // Reopening without signal: the app shell comes from the service worker, the dossier from the device.
  await phone.reload();
  await expect(phone.getByRole('navigation', { name: 'Etapele vizitei' })).toBeVisible();
  await expect(phone.getByText(/modificări pe dispozitiv – se trimit când revine semnalul/)).toBeVisible();

  await ctx.setOffline(false);
  await phone.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(phone.getByText(/Totul este salvat pe server/)).toBeVisible({ timeout: 30_000 });
  await phone.getByRole('button', { name: '3 · Raportez' }).click();
  await phone.getByRole('button', { name: 'Semnează raportul și trimite la avizare' }).click();
  await phone.waitForURL(`**/dosare/${id}`, { timeout: 60_000 });
  await expect(phone.getByText(/Dosarul este la: Avizare șef serviciu/)).toBeVisible();

  const evidence = await api(desk, 'GET', `/instances/${id}/evidence`);
  const photo = evidence.items.find((e: any) => e.kind === 'photo');
  expect(photo.caption).toBe('Hala de producție');
  expect(photo.section).toBe('2.2 Stadiul activităților');
  expect(Number(photo.latitude)).toBeCloseTo(47.1585, 3);
  expect(evidence.items.some((e: any) => e.kind === 'signature' && e.signer_name === 'Ion Popescu')).toBe(true);
});
