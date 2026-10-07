import { formatAmount } from '@flux/validators';

export { formatAmount };

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return new Date(v).toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAmount(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  try {
    return formatAmount(String(v));
  } catch {
    return String(v);
  }
}

export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: 'introdus manual',
  project: 'din proiect',
  beneficiary: 'din fișa beneficiarului',
  anaf: 'din ANAF',
  mysmis: 'din MySMIS',
  import: 'din import',
  calculated: 'calculat',
  previous_instance: 'din dosarul anterior',
};

export const ROLE_LABEL: Record<string, string> = {
  registry_inspector: 'Registratură',
  evf_expert: 'Expert EVF',
  ei_expert: 'Expert EI',
  procurement_expert: 'Expert achiziții',
  head_of_unit: 'Șef serviciu',
  director: 'Director',
  cfpp: 'CFPP',
  legal_advisor: 'Consilier juridic',
  functional_admin: 'Administrator funcțional',
  it_admin: 'Administrator IT',
  auditor: 'Auditor',
};
