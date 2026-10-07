import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { config } from '../core/config.js';

const execFileAsync = promisify(execFile);

/** Fills a DOCX template ({field}, {#rows}...{/rows}, {#cond}...{/cond}). Missing values render empty. */
export function renderDocx(template: Buffer, data: Record<string, unknown>): Buffer {
  const zip = new PizZip(template);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '',
    // Dotted paths ({project.smis_code}); docxtemplater walks up the loop scopes when undefined.
    parser: (tag: string) => ({
      get: (scope: unknown) =>
        tag === '.' ? scope : tag.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), scope),
    }),
  });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}

let converterAvailable: boolean | undefined;

export async function pdfConversionAvailable(): Promise<boolean> {
  if (!config.sofficePath) return false;
  if (converterAvailable === undefined) {
    converterAvailable = await execFileAsync(config.sofficePath, ['--version'], { timeout: 20_000 }).then(
      () => true,
      () => false,
    );
  }
  return converterAvailable;
}

/** DOCX -> PDF with LibreOffice headless; one private profile per call so conversions can run in parallel. */
export async function docxToPdf(docx: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'flux-pdf-'));
  try {
    const input = join(dir, 'document.docx');
    await writeFile(input, docx);
    await execFileAsync(
      config.sofficePath,
      [`-env:UserInstallation=file://${join(dir, `profile-${randomUUID()}`)}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input],
      { timeout: 120_000 },
    );
    return await readFile(join(dir, 'document.pdf'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
