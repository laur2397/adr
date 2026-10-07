import { checkCui, normalizeCui } from '@flux/validators';
import { config, today } from '../../core/config.js';
import { AppError } from '../../core/errors.js';

export interface AnafCompany {
  cui: string;
  name: string;
  tradeRegisterNo: string | null;
  caenCode: string | null;
  address: string | null;
  county: string | null;
  vatPayer: boolean;
  status: string | null;
  fetchedAt: string;
  raw: unknown;
}

const MOCK: Record<string, Partial<AnafCompany>> = {
  '1590082': { name: 'AUTOMOBILE DACIA SA', tradeRegisterNo: 'J03/57/1991', caenCode: '2910', county: 'ARGEȘ', address: 'Mioveni, Str. Uzinei nr. 1', vatPayer: true },
};

function mockLookup(cui: string): AnafCompany {
  const m = MOCK[cui] ?? {
    name: `BENEFICIAR TEST ${cui} SRL`,
    tradeRegisterNo: `J35/${Number(cui) % 9000}/2015`,
    caenCode: '6201',
    county: 'TIMIȘ',
    address: `Timișoara, Str. Exemplu nr. ${Number(cui) % 100}`,
    vatPayer: Number(cui) % 2 === 0,
  };
  return {
    cui,
    name: m.name!,
    tradeRegisterNo: m.tradeRegisterNo ?? null,
    caenCode: m.caenCode ?? null,
    address: m.address ?? null,
    county: m.county ?? null,
    vatPayer: m.vatPayer ?? false,
    status: 'INREGISTRAT',
    fetchedAt: new Date().toISOString(),
    raw: { mock: true },
  };
}

/**
 * Looks a company up in the ANAF public web service (PlatitorTvaRest). The service is public and
 * rate-limited (about 1 request/second, up to 100 CUIs per request); callers should not loop on it.
 */
export async function lookupCompany(input: string): Promise<AnafCompany> {
  const check = checkCui(input);
  if (!check.ok) throw new AppError(400, check.message, [{ field: 'cui', message: check.message }]);
  const cui = normalizeCui(input);
  if (config.anafMode === 'mock') return mockLookup(cui);
  let res: Response;
  try {
    res = await fetch(config.anafUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ cui: Number(cui), data: today() }]),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError(503, 'Serviciul ANAF nu răspunde. Încercați din nou peste câteva minute sau completați datele manual.');
  }
  if (!res.ok) throw new AppError(503, `Serviciul ANAF a răspuns cu eroarea ${res.status}. Încercați din nou mai târziu.`);
  const body = (await res.json()) as { found?: Array<Record<string, any>>; notFound?: unknown[] };
  const found = body.found?.[0];
  if (!found) throw new AppError(404, `CUI-ul ${cui} nu a fost găsit în baza de date ANAF.`);
  const g = found.date_generale ?? {};
  const s = found.adresa_sediu_social ?? {};
  return {
    cui,
    name: g.denumire,
    tradeRegisterNo: g.nrRegCom || null,
    caenCode: g.cod_CAEN || null,
    address: g.adresa || null,
    county: s.sdenumire_Judet || null,
    vatPayer: Boolean(found.inregistrare_scop_Tva?.scpTVA),
    status: g.stare_inregistrare || null,
    fetchedAt: new Date().toISOString(),
    raw: found,
  };
}
