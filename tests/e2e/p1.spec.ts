import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Acceptance criterion 1 through the user interface: a P1 dossier goes from registration to
 * approval, with the expense table, checklist, generated and signed documents and registrations.
 */
const PASSWORD = 'Parola-e2e-2026';

async function login(browser: Browser, username: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByLabel('Utilizator').fill(username);
  await page.getByLabel('Parolă').fill(PASSWORD);
  await page.getByRole('button', { name: 'Intră în cont' }).click();
  await expect(page.getByRole('heading', { name: /Bună ziua/ })).toBeVisible();
  return page;
}

async function takePath(page: Page, label: string, comment?: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (comment) await dialog.getByLabel(/Comentariu/).fill(comment);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

async function openFromPanel(page: Page, title: RegExp) {
  await page.goto('/');
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SMIS 302145');
}

test('P1 dossier from registration to approval', async ({ browser }) => {
  // Registry: new dossier with prefilled data, registration number.
  const registry = await login(browser, 'registratura');
  await registry.getByRole('link', { name: 'Dosar nou' }).first().click();
  await registry.getByLabel(/Verificarea cererii de rambursare/).check();
  await registry.getByLabel('Alege proiectul 302145').check();
  await registry.getByRole('button', { name: 'Creează dosarul' }).click();
  await expect(registry.getByText('Precompletat din proiect').first()).toBeVisible();
  await registry.getByLabel('Număr cerere MySMIS').fill('CR-21');
  await registry.getByLabel('Tip cerere').selectOption('rambursare');
  await registry.getByLabel('Data depunerii în MySMIS').fill('2026-10-05');
  await registry.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(registry.getByText('Datele au fost salvate.')).toBeVisible();
  await takePath(registry, 'Înregistrează și repartizează');
  await expect(registry.getByText(/Nr\. înregistrare \d+\//)).toBeVisible();
  await expect(registry.getByText(/Dosarul este la: Verificare financiară \(EVF\) \(Andrei Ionescu\)/)).toBeVisible();

  // EVF expert: expense lines, findings, checklist, sign, submit.
  const evf = await login(browser, 'evf1');
  await openFromPanel(evf, /Verificarea cererii de rambursare/);
  await evf.getByRole('button', { name: 'Adaugă rând' }).click();
  await evf.getByLabel('Linie bugetară, rândul 1').selectOption('1.1');
  await evf.getByLabel('Document justificativ, rândul 1').fill('Factura 12/2026');
  await evf.getByLabel('Sumă solicitată, rândul 1').fill('50.000,00');
  await evf.getByLabel('Sumă eligibilă, rândul 1').fill('48.500,00');
  await evf.getByLabel('Motiv, rândul 1').fill('Cheltuieli de transport neeligibile');
  await evf.getByRole('button', { name: 'Salvează tabelul' }).click();
  await expect(evf.getByRole('cell', { name: '1.500,00' }).first()).toBeVisible();
  await evf.getByLabel('Constatări').fill('Diminuare 1.500,00 lei (transport).');
  await evf.getByRole('button', { name: 'Salvează', exact: true }).click();
  await expect(evf.getByText('Datele au fost salvate.')).toBeVisible();

  // Submitting too early lists exactly what is missing.
  await evf.getByRole('button', { name: 'Trimite la șeful de serviciu' }).click();
  await evf.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
  await expect(evf.getByRole('dialog').getByText(/punctul 1 nu are răspuns/)).toBeVisible();
  await expect(evf.getByRole('dialog').getByText(/Semnați documentul/)).toBeVisible();
  await evf.getByRole('dialog').getByRole('button', { name: 'Renunță' }).click();

  await evf.getByRole('tab', { name: 'Listă de verificare' }).click();
  for (let i = 1; i <= 8; i++) await evf.getByRole('group', { name: `Răspuns la punctul ${i}` }).getByLabel('Da', { exact: true }).check();
  await evf.getByRole('button', { name: 'Salvează lista' }).click();
  await expect(evf.getByText('8/8 completate')).toBeVisible();

  await evf.getByRole('tab', { name: /Documente/ }).click();
  await evf.getByRole('button', { name: /Semnează/ }).first().click();
  await expect(evf.getByText('Documentul a fost semnat.')).toBeVisible({ timeout: 60_000 });
  await expect(evf.getByText('SIMULARE').first()).toBeVisible();
  await takePath(evf, 'Trimite la șeful de serviciu');

  // Head of unit: sign and endorse.
  const head = await login(browser, 'sef.svf');
  await openFromPanel(head, /Verificarea cererii de rambursare/);
  await head.getByRole('tab', { name: /Documente/ }).click();
  await head.getByRole('button', { name: 'Semnează', exact: true }).click();
  await expect(head.getByText('Documentul a fost semnat.')).toBeVisible({ timeout: 60_000 });
  await takePath(head, 'Avizează');

  // Director: sign both documents and approve.
  const director = await login(browser, 'director');
  await openFromPanel(director, /Verificarea cererii de rambursare/);
  await director.getByRole('tab', { name: /Documente/ }).click();
  for (const _ of [0, 1]) {
    const sign = director.getByRole('button', { name: /^(Semnează|Generează și semnează)$/ }).first();
    await sign.click();
    await expect(director.getByText('Documentul a fost semnat.')).toBeVisible({ timeout: 60_000 });
    await director.reload();
    await director.getByRole('tab', { name: /Documente/ }).click();
  }
  await takePath(director, 'Aprobă și semnează');
  await expect(director.getByText('Finalizat').first()).toBeVisible();
  await director.getByRole('tab', { name: 'Înregistrări' }).click();
  await expect(director.getByRole('cell', { name: 'Ieșire', exact: true })).toBeVisible();
  await expect(director.getByRole('cell', { name: /Registrul cererilor/ })).toBeVisible();
  await director.getByRole('tab', { name: 'Termene' }).click();
  await expect(director.getByRole('row', { name: /Verificarea cererii de plată/ })).toContainText('respectat');
});
