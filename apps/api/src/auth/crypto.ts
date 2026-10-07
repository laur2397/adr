import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../core/config.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
// scrypt (memory-hard, in Node's standard library): N=2^15, r=8, p=1 -> 32 MiB per hash.
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, salt, key] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

/** Password policy (shown to the user when it fails). */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Parola trebuie să aibă cel puțin 12 caractere.');
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) problems.push('Parola trebuie să conțină litere și cifre.');
  return problems;
}

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

// --- TOTP (RFC 6238, SHA-1, 30 s, 6 digits: what authenticator apps expect) -------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secretBase32: string, time = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(bin).padStart(6, '0');
}

/** Accepts the current code and one step of clock drift either way. */
export function verifyTotp(secretBase32: string, code: string, time = Date.now()): boolean {
  const c = code.replace(/\s/g, '');
  return [-1, 0, 1].some((d) => totpCode(secretBase32, time + d * 30_000) === c);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

// --- Encryption of secrets at rest (AES-256-GCM with APP_KEY) --------------------------------

function appKey(): Buffer {
  const key = Buffer.from(config.appKey, 'base64');
  if (key.length !== 32) throw new Error('APP_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
  return key;
}

export function encrypt(plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', appKey(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function decrypt(data: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', appKey(), data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8');
}
