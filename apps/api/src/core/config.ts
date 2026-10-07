import { resolve } from 'node:path';

const env = process.env;

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'da'].includes(v.toLowerCase());
}

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/flux',
  /** Directory for document files (filesystem storage). */
  storageDir: resolve(env.STORAGE_DIR ?? 'storage'),
  /** Secure cookies require HTTPS; disable only for local development. */
  secureCookies: bool(env.SECURE_COOKIES, env.NODE_ENV === 'production'),
  sessionHours: Number(env.SESSION_HOURS ?? 10),
  /** Key used to encrypt TOTP secrets at rest (32 bytes, base64). Generated at install time. */
  appKey: env.APP_KEY ?? '',
  /** ANAF: 'live' calls the public web service, 'mock' answers from local fixtures (tests, offline demo). */
  anafMode: (env.ANAF_MODE ?? 'live') as 'live' | 'mock',
  anafUrl: env.ANAF_URL ?? 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva',
  /** Path to soffice for DOCX -> PDF; empty disables PDF conversion. */
  sofficePath: env.SOFFICE_PATH ?? 'soffice',
  /** Signature provider adapter: 'simulated' is for development and demos only. */
  signatureProvider: env.SIGNATURE_PROVIDER ?? 'simulated',
  smtpUrl: env.SMTP_URL ?? '',
  mailFrom: env.MAIL_FROM ?? 'flux-am@localhost',
  publicUrl: env.PUBLIC_URL ?? 'http://localhost:5173',
  /** Instance time zone used for "today" in deadline computations. */
  timeZone: env.TZ_INSTITUTION ?? 'Europe/Bucharest',
};

let todayOverride: string | null = process.env.FLUX_TODAY ?? null;

/** Fixes "today" (tests and demos of deadline behaviour only). */
export function setTodayOverride(day: string | null): void {
  todayOverride = day;
}

/** Today's date (YYYY-MM-DD) in the institution's time zone. */
export function today(now: Date = new Date()): string {
  if (todayOverride) return todayOverride;
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
