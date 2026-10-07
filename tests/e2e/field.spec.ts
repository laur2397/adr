import { devices, expect, test, type Page } from '@playwright/test';
import { demoPhoto } from '../../apps/api/src/seed/images';

/**
 * On-site verification on a phone: the inspector works without signal (checklist, findings, photos
 * with GPS, signature), reopens the page offline, then the changes are sent when the signal returns
 * and the report is signed and submitted.
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

test('field visit offline, synced and submitted', async ({ browser }) => {
  // Head of the monitoring unit schedules a visit (through the API, the UI is covered elsewhere).
  const desk = await (await browser.newContext()).newPage();
  await login(desk, 'sef.sm');
  const project = (await api(desk, 'GET', '/projects')).items[0];
  const { id } = await api(desk, 'POST', '/instances', { definitionKey: 'p8_onsite_verification', projectId: project.id });
  const planning = (await api(desk, 'GET', `/instances/${id}`)).tasks.find((t: any) => t.canAct);
  await api(desk, 'PATCH', `/instances/${id}/fields`, { taskId: planning.id, fields: { visit_reason: 'monitorizare', planned_date: '2099-01-15', location: 'Str. Fabricii 12, Iași' } });
  await api(desk, 'POST', `/instances/${id}/transitions`, { taskId: planning.id, path: 'schedule' });

  const ctx = await browser.newContext({ ...devices['Pixel 7'], geolocation: { latitude: 47.1585, longitude: 27.6014, accuracy: 6 }, permissions: ['geolocation'] });
  const phone = await ctx.newPage();
  await login(phone, 'ei1');
  await phone.goto(`/teren/${id}`);
  await phone.getByRole('button', { name: 'Completează declarația' }).click();
  await phone.getByRole('dialog').getByRole('button', { name: 'Semnez declarația' }).click();
  await phone.getByRole('button', { name: 'Preiau vizita' }).click();
  await expect(phone.getByRole('button', { name: 'Preiau vizita' })).toBeHidden();
  await expect(phone.getByText(/Poziția dvs\.: 47\.15850, 27\.60140/)).toBeVisible();

  await ctx.setOffline(true);
  await phone.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(phone.getByText('fără semnal')).toBeVisible();
  for (let i = 1; i <= 12; i++) await phone.getByRole('group', { name: `Răspuns la punctul ${i}`, exact: true }).getByRole('button', { name: 'Da', exact: true }).click();
  await phone.getByLabel(/Reprezentantul beneficiarului/).fill('Ion Popescu');
  await phone.getByLabel(/^Constatări/).fill('Echipamentele sunt instalate și funcționale.');
  await phone.getByLabel(/Rezultatul verificării/).selectOption('conform');
  await phone.getByLabel('Descrierea fotografiei').fill('Hala de producție');
  await phone.locator('input[type=file][capture]').setInputFiles({ name: 'hala.png', mimeType: 'image/png', buffer: demoPhoto('building', 1) });
  await expect(phone.getByText('Fotografie salvată pe dispozitiv.')).toBeVisible();
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
  await expect(phone.getByText('Lista de verificare')).toBeVisible();
  await expect(phone.getByText(/modificări pe dispozitiv – se trimit când revine semnalul/)).toBeVisible();

  await ctx.setOffline(false);
  await phone.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(phone.getByText(/Totul este salvat pe server/)).toBeVisible({ timeout: 30_000 });
  await phone.getByRole('button', { name: 'Semnează raportul și trimite la avizare' }).click();
  await phone.waitForURL(`**/dosare/${id}`, { timeout: 60_000 });
  await expect(phone.getByText(/Dosarul este la: Avizare șef serviciu/)).toBeVisible();

  const evidence = await api(desk, 'GET', `/instances/${id}/evidence`);
  const photo = evidence.items.find((e: any) => e.kind === 'photo');
  expect(photo.caption).toBe('Hala de producție');
  expect(Number(photo.latitude)).toBeCloseTo(47.1585, 3);
  expect(evidence.items.some((e: any) => e.kind === 'signature' && e.signer_name === 'Ion Popescu')).toBe(true);
});
