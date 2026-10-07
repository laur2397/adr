/**
 * Validators and formatters shared by the API and the UI. Messages are in Romanian because they
 * are shown to users as-is.
 */

export type Check = { ok: true } | { ok: false; message: string };
const ok: Check = { ok: true };
const fail = (message: string): Check => ({ ok: false, message });

/** Romanian fiscal code (CUI/CIF): 2-10 digits, last one a control digit (key 753217532). */
export function normalizeCui(input: string): string {
  return input.trim().toUpperCase().replace(/^RO/, '').replace(/\s+/g, '');
}

export function checkCui(input: string): Check {
  const cui = normalizeCui(input);
  if (!/^\d{2,10}$/.test(cui)) return fail('CUI-ul trebuie să conțină între 2 și 10 cifre (opțional precedat de RO).');
  const key = '753217532';
  const body = cui.slice(0, -1).padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * Number(key[i]);
  const control = ((sum * 10) % 11) % 10;
  return control === Number(cui.at(-1)) ? ok : fail('CUI-ul nu este valid: cifra de control nu corespunde. Verificați numărul.');
}

/** IBAN with ISO 13616 mod-97 check; Romanian IBANs have 24 characters. */
export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function checkIban(input: string): Check {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return fail('IBAN-ul are un format greșit.');
  if (iban.startsWith('RO') && iban.length !== 24) return fail('Un IBAN românesc are 24 de caractere.');
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1 ? ok : fail('IBAN-ul nu este valid: cifrele de control nu corespund. Verificați contul.');
}

/** MySMIS project code: digits only (SMIS 2014+ and SMIS 2021+ codes have 5-7 digits). */
export function checkSmisCode(input: string): Check {
  return /^\d{5,7}$/.test(input.trim()) ? ok : fail('Codul SMIS trebuie să conțină între 5 și 7 cifre.');
}

export function checkEmail(input: string): Check {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim()) ? ok : fail('Adresa de e-mail nu este validă.');
}

// ---------------------------------------------------------------------------------------------
// Money: amounts travel as decimal strings ("1234.56") and are computed in integer bani (BigInt),
// never as floating point.
// ---------------------------------------------------------------------------------------------

export type Amount = string;

/** Parses "1.234,56", "1234,56", "1234.56" or a number into a canonical "1234.56". */
export function parseAmount(input: string | number): Amount {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Suma nu este un număr valid.');
    return fromBani(BigInt(Math.round(input * 100)));
  }
  let s = input.trim().replace(/\s|lei|ron/gi, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Suma „${input}” nu este validă. Folosiți formatul 1.234,56.`);
  return fromBani(toBani(s));
}

export function toBani(amount: Amount): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!m) throw new Error(`Invalid amount: ${amount}`);
  const bani = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -bani : bani;
}

export function fromBani(bani: bigint): Amount {
  const neg = bani < 0n;
  const abs = neg ? -bani : bani;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export function addAmounts(...amounts: Array<Amount | null | undefined>): Amount {
  return fromBani(amounts.reduce<bigint>((s, a) => s + (a ? toBani(a) : 0n), 0n));
}

export function subtractAmounts(a: Amount, b: Amount): Amount {
  return fromBani(toBani(a) - toBani(b));
}

export function compareAmounts(a: Amount, b: Amount): number {
  const d = toBani(a) - toBani(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** amount × factor (quantity, VAT rate), rounded half away from zero to the ban. */
export function multiplyAmount(amount: Amount, factor: number | string): Amount {
  const f = String(factor).replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(f);
  if (!m) throw new Error(`Invalid factor: ${factor}`);
  const decimals = (m[3] ?? '').length;
  const scaled = BigInt(m[2]! + (m[3] ?? '')) * (m[1] ? -1n : 1n);
  const denom = 10n ** BigInt(decimals);
  const product = toBani(amount) * scaled;
  const half = denom / 2n;
  const rounded = product >= 0n ? (product + half) / denom : -((-product + half) / denom);
  return fromBani(denom === 1n ? product : rounded);
}

/** "1234567.5" -> "1.234.567,50" */
export function formatAmount(amount: Amount): string {
  const [int, dec] = fromBani(toBani(amount)).split('.') as [string, string];
  const neg = int.startsWith('-');
  const digits = neg ? int.slice(1) : int;
  return `${neg ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

/** "2026-10-07" -> "07.10.2026" */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** "07.10.2026" -> "2026-10-07" */
export function parseDate(ro: string): string {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(ro.trim());
  if (!m) throw new Error(`Data „${ro}” nu este validă. Folosiți formatul zz.ll.aaaa.`);
  return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}
