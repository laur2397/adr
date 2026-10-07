import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { config } from '../core/config.js';

export type SignatureLevel = 'simple' | 'advanced' | 'qualified' | 'seal';

export interface SignRequest {
  signatureId: string;
  pdf: Buffer;
  fileName: string;
  signer: { name: string; email: string; role: string };
  level: SignatureLevel;
  reason: string;
  sequence: number;
}

export type SignResult =
  | { status: 'completed'; signedPdf: Buffer; providerReference: string; format: string | null; validation: Record<string, unknown> }
  /** Remote QES: the signer confirms on the provider's page or mobile app; the provider calls back. */
  | { status: 'pending'; providerReference: string; redirectUrl?: string; instructions?: string };

export interface SignatureProvider {
  readonly name: string;
  readonly levels: SignatureLevel[];
  sign(req: SignRequest): Promise<SignResult>;
  /** Parses and authenticates a provider callback; returns the signed PDF when the signature is done. */
  handleCallback?(headers: Record<string, unknown>, body: unknown): Promise<{ providerReference: string; signedPdf: Buffer; format: string } | null>;
}

const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');

/**
 * Development/demo provider. It stamps a visible line on the last page and marks the signature
 * as SIMULATED. It has no legal value and is refused when NODE_ENV=production.
 */
export class SimulatedProvider implements SignatureProvider {
  readonly name = 'simulated';
  readonly levels: SignatureLevel[] = ['simple', 'advanced', 'qualified', 'seal'];

  async sign(req: SignRequest): Promise<SignResult> {
    const pdf = await PDFDocument.load(req.pdf);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.getPages().at(-1)!;
    const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
    page.drawText(
      ascii(`[SIMULARE - fara valoare juridica] Semnat (${req.level}) de ${req.signer.name}, ${req.signer.role}, la ${when} UTC`),
      { x: 36, y: 14 + (req.sequence - 1) * 10, size: 7, font, color: rgb(0.6, 0.1, 0.1) },
    );
    const signedPdf = Buffer.from(await pdf.save());
    return {
      status: 'completed',
      signedPdf,
      providerReference: `sim-${req.signatureId}`,
      format: null,
      validation: { simulated: true, result: 'SIMULATED', message: 'Semnătură simulată pentru testare; nu are valoare juridică.' },
    };
  }
}

let provider: SignatureProvider | undefined;

export function signatureProvider(): SignatureProvider {
  if (provider) return provider;
  switch (config.signatureProvider) {
    case 'simulated':
      if (config.env === 'production' && process.env.ALLOW_SIMULATED_SIGNATURES !== 'true') {
        throw new Error('SIGNATURE_PROVIDER=simulated is refused in production (set ALLOW_SIMULATED_SIGNATURES=true only on a test/pilot install).');
      }
      provider = new SimulatedProvider();
      return provider;
    default:
      // Adapters for certSIGN Paperless, DigiSign, Trans Sped or Namirial are added here once the
      // provider is chosen and its API documentation and test environment are available.
      throw new Error(`Signature provider "${config.signatureProvider}" is not implemented.`);
  }
}

export function setSignatureProvider(p: SignatureProvider | undefined): void {
  provider = p;
}

/** Signed PDFs contain a /ByteRange entry in each signature dictionary. */
export function looksSigned(pdf: Buffer): boolean {
  return pdf.includes('/ByteRange');
}

/**
 * Validates the signatures of a PDF with an EU DSS service (DSS_URL, e.g. the dss-demo-webapp
 * REST endpoint). Without DSS the result says so explicitly instead of pretending.
 */
export async function validatePdfSignatures(pdf: Buffer, fileName: string): Promise<Record<string, unknown>> {
  const dssUrl = process.env.DSS_URL;
  if (!dssUrl) return { result: 'NOT_VALIDATED', message: 'Serviciul de validare (DSS) nu este configurat.' };
  const res = await fetch(`${dssUrl.replace(/\/$/, '')}/services/rest/validation/validateSignature`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ signedDocument: { bytes: pdf.toString('base64'), name: fileName }, originalDocuments: [], policy: null, signatureId: null }),
  });
  if (!res.ok) return { result: 'ERROR', message: `DSS a răspuns ${res.status}.` };
  const report = (await res.json()) as { SimpleReport?: { signatureOrTimestampOrEvidenceRecord?: Array<Record<string, any>> } };
  const sigs = report.SimpleReport?.signatureOrTimestampOrEvidenceRecord ?? [];
  return {
    result: sigs.length && sigs.every((s) => s.Signature?.Indication === 'TOTAL_PASSED') ? 'TOTAL_PASSED' : sigs.length ? 'NOT_PASSED' : 'NO_SIGNATURE',
    signatures: sigs.map((s) => ({
      signedBy: s.Signature?.SignedBy,
      indication: s.Signature?.Indication,
      subIndication: s.Signature?.SubIndication,
      level: s.Signature?.SignatureLevel?.value,
      signingTime: s.Signature?.SigningTime,
    })),
  };
}
