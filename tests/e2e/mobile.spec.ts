import { devices, expect, test, type Page } from '@playwright/test';

/**
 * Director and heads of unit on a phone: no page is wider than the screen, the menu opens as a
 * drawer, and a dossier can be signed and approved from the task panel, without the Documents tab.
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

test('director on a small phone: layout fits, sign and approve from the task panel', async ({ browser }) => {
  // A P7 decision waiting for the director's signature, prepared through the API.
  const desk = await (await browser.newContext()).newPage();
  await login(desk, 'sef.svf');
  const { id } = await api(desk, 'POST', '/instances', { definitionKey: 'p7_decisions', title: 'Decizie privind lucrul de pe telefon' });
  const step = async (page: Page) => (await api(page, 'GET', `/instances/${id}`)).tasks.find((t: any) => t.canAct);
  let t = await step(desk);
  await api(desk, 'PATCH', `/instances/${id}/fields`, { taskId: t.id, fields: { decision_type: 'altele', decision_subject: 'lucrul de pe telefon', legal_basis: 'Având în vedere…', articles: 'Art. 1. …', recipients: 'toate compartimentele' } });
  await api(desk, 'POST', `/instances/${id}/transitions`, { taskId: t.id, path: 'submit' });
  for (const [user, path] of [['sef.sm', 'endorse'], ['juridic', 'favorable']] as const) {
    const pg = await (await browser.newContext()).newPage();
    await login(pg, user);
    t = await step(pg);
    if (user === 'juridic') await api(pg, 'PATCH', `/instances/${id}/fields`, { taskId: t.id, fields: { legal_opinion: 'Aviz favorabil.' } });
    await api(pg, 'POST', `/instances/${id}/transitions`, { taskId: t.id, path });
  }

  const ctx = await browser.newContext({ ...devices['iPhone SE'] });
  const phone = await ctx.newPage();
  await login(phone, 'director');
  const width = phone.viewportSize()!.width;
  for (const url of ['/', '/dosare', '/tablou', '/vizite', '/registre', '/esantionare', '/cont', `/dosare/${id}`]) {
    await phone.goto(url);
    await phone.waitForLoadState('networkidle');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth), `${url} is wider than the screen`).toBeLessThanOrEqual(width);
  }

  // Menu drawer and bottom bar.
  await phone.getByRole('button', { name: 'Meniu' }).first().click();
  await expect(phone.getByRole('navigation', { name: 'Navigare principală' }).getByRole('link', { name: 'Tablou de bord' })).toBeInViewport();
  await phone.getByRole('navigation', { name: 'Navigare principală' }).getByRole('link', { name: 'Dosare', exact: true }).click();
  await expect(phone.getByRole('heading', { name: 'Dosare' })).toBeVisible();
  await expect(phone.getByRole('navigation', { name: 'Navigare rapidă' })).toBeVisible();

  // Sign from the task panel, then approve.
  await phone.goto(`/dosare/${id}`);
  const panel = phone.getByRole('list', { name: 'Documente de semnat la acest pas' });
  await panel.getByRole('button', { name: /Semnează/ }).click();
  await expect(panel.getByText('Semnat de dvs.')).toBeVisible({ timeout: 60_000 });
  await phone.getByRole('button', { name: 'Semnează decizia', exact: true }).click();
  await phone.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(phone.getByText('În vigoare').first()).toBeVisible();
});
