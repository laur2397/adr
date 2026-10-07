import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../core/config.js';

/**
 * Content-addressed file storage: the key is the SHA-256 of the content, so a stored file can
 * never be changed in place and duplicates are stored once. An S3 implementation can replace
 * this one behind the same three functions.
 */
export interface StoredFile {
  storageKey: string;
  sha256: Buffer;
  size: number;
}

export async function putFile(content: Buffer): Promise<StoredFile> {
  const sha256 = createHash('sha256').update(content).digest();
  const hex = sha256.toString('hex');
  const storageKey = `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
  const path = join(config.storageDir, storageKey);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
  return { storageKey, sha256, size: content.length };
}

export async function getFile(storageKey: string): Promise<Buffer> {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(storageKey)) throw new Error('invalid storage key');
  const content = await readFile(join(config.storageDir, storageKey));
  const actual = createHash('sha256').update(content).digest('hex');
  if (!storageKey.endsWith(actual)) throw new Error(`Integrity check failed for ${storageKey}`);
  return content;
}
