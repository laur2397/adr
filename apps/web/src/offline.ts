/**
 * Offline support for on-site visits. The field page keeps, per dossier, a copy of the dossier and
 * a queue of changes (fields, checklist answers, photos, signature) in IndexedDB. Changes are sent
 * in order when the device is online; a photo has a client id, so a re-send after a dropped
 * connection is recognized by the server and not duplicated.
 */

const DB_NAME = 'flux-field';
const DB_VERSION = 1;

export type QueuedOp =
  | { id?: number; instanceId: string; kind: 'fields'; taskId: string; fields: Record<string, unknown>; createdAt: string; error?: string }
  | { id?: number; instanceId: string; kind: 'checklist'; taskId: string; checklistKey: string; responses: Array<{ code: string; answer: string | null; observation: string | null }>; createdAt: string; error?: string }
  | {
      id?: number;
      instanceId: string;
      kind: 'evidence';
      blob: Blob;
      meta: { kind: 'photo' | 'signature'; clientId: string; caption?: string; takenAt: string; latitude?: number; longitude?: number; accuracy?: number; signerName?: string };
      createdAt: string;
      error?: string;
    };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('dossiers')) db.createObjectStore('dossiers');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }).createIndex('instance', 'instanceId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store<T>(name: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** Snapshot of everything the field page needs, kept for opening the visit without signal. */
export interface FieldSnapshot {
  dossier: any;
  evidence: any[];
  results: Array<{ code: string; label: string }>;
  savedAt: string;
}

export const saveSnapshot = (id: string, s: FieldSnapshot) => store('dossiers', 'readwrite', (st) => st.put(s, id));
export const loadSnapshot = (id: string) => store<FieldSnapshot>('dossiers', 'readonly', (st) => st.get(id));

export async function pending(instanceId: string): Promise<QueuedOp[]> {
  const all = (await store<QueuedOp[]>('queue', 'readonly', (st) => st.index('instance').getAll(instanceId))) ?? [];
  return all.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/** Adds a change. Field and checklist changes replace a not-yet-sent change of the same kind. */
export async function enqueue(op: QueuedOp): Promise<void> {
  if (op.kind === 'fields' || op.kind === 'checklist') {
    const prev = (await pending(op.instanceId)).find((p) => p.kind === op.kind && !p.error);
    if (prev && prev.kind === 'fields' && op.kind === 'fields') {
      await store('queue', 'readwrite', (st) => st.put({ ...prev, fields: { ...prev.fields, ...op.fields }, taskId: op.taskId }));
      return;
    }
    if (prev && prev.kind === 'checklist' && op.kind === 'checklist') {
      await store('queue', 'readwrite', (st) => st.put({ ...op, id: prev.id }));
      return;
    }
  }
  await store('queue', 'readwrite', (st) => st.add(op));
}

export const removeOp = (id: number) => store('queue', 'readwrite', (st) => st.delete(id));

export class OfflineError extends Error {}

async function send(op: QueuedOp): Promise<void> {
  let res: Response;
  try {
    if (op.kind === 'fields') {
      res = await fetch(`/api/v1/instances/${op.instanceId}/fields`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-flux-csrf': '1' },
        body: JSON.stringify({ taskId: op.taskId, fields: op.fields }),
      });
    } else if (op.kind === 'checklist') {
      res = await fetch(`/api/v1/instances/${op.instanceId}/checklists/${op.checklistKey}/responses`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-flux-csrf': '1' },
        body: JSON.stringify({ taskId: op.taskId, responses: op.responses }),
      });
    } else {
      const form = new FormData();
      for (const [k, v] of Object.entries(op.meta)) if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
      form.append('file', op.blob, op.meta.kind === 'signature' ? 'semnatura.png' : 'foto.jpg');
      res = await fetch(`/api/v1/instances/${op.instanceId}/evidence`, { method: 'POST', headers: { 'x-flux-csrf': '1' }, body: form });
    }
  } catch {
    throw new OfflineError('Fără conexiune');
  }
  if (res.status >= 500 || res.status === 0) throw new OfflineError(`Server indisponibil (${res.status})`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = [body.title, ...(body.errors ?? []).map((e: { message: string }) => e.message)].filter(Boolean).join(' ');
    throw new Error(detail || `Eroare ${res.status}`);
  }
}

/**
 * Sends the queued changes in order. Stops at the first network failure (the rest waits for the
 * next attempt); a change the server refuses is kept with its error, for the user to fix or drop.
 */
export async function flush(instanceId: string): Promise<{ sent: number; failed: number; offline: boolean }> {
  let sent = 0;
  let failed = 0;
  for (const op of await pending(instanceId)) {
    if (op.error) {
      failed += 1;
      continue;
    }
    try {
      await send(op);
      await removeOp(op.id!);
      sent += 1;
    } catch (err) {
      if (err instanceof OfflineError) return { sent, failed, offline: true };
      await store('queue', 'readwrite', (st) => st.put({ ...op, error: (err as Error).message }));
      failed += 1;
    }
  }
  return { sent, failed, offline: false };
}

/** Retries a refused change (after the user fixed the cause, e.g. declared the conflict of interest). */
export const retryOp = async (op: QueuedOp) => store('queue', 'readwrite', (st) => st.put({ ...op, error: undefined }));

/** Shrinks a camera photo (often 4–12 MB) to at most 1600 px and JPEG quality 0.82 before storing it. */
export async function compressPhoto(file: Blob, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Fotografia nu a putut fi procesată.'))), 'image/jpeg', 0.82));
}

export function newClientId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
