import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { CoiBanner } from '../components/Collaboration';
import { gpsLabel, mapLink, SignaturePad } from '../components/Evidence';
import { FieldGuide } from '../components/FieldGuide';
import { ErrorAlert, Loading } from '../components/ui';
import { fmtAmount, fmtDate, fmtDateTime, todayIso } from '../format';
import { compressPhoto, enqueue, flush, loadSnapshot, newClientId, pending, removeOp, retryOp, saveSnapshot, type FieldSnapshot, type QueuedOp } from '../offline';

/**
 * The monitoring officer's on-site visit, on a phone or tablet, in the four phases of the visit:
 * PREGĂTESC (file, team, equipment, risks), VERIFIC (the sections of the report, Anexa 6 to Ordinul
 * MIPE 1777/2023, with photos tagged by section), RAPORTEZ (conclusions, recommendations, signature)
 * and the guide. Works without signal: the dossier, the code lists and the previous visit's photos
 * are kept on the device, every change is queued and sent when the connection returns.
 */

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;
  at: number;
}
type Row = Record<string, any>;
type Answer = { answer: string | null; observation: string };
type Tab = 'prepare' | 'verify' | 'report' | 'guide';

const NOMENCLATURES = ['visit_result', 'equipment_status', 'recommendation_status', 'verification_method', 'deviation_type', 'escalation_level', 'visit_team_role', 'visit_reason', 'visit_project_kind'];
const WORKS_KINDS = ['lucrari', 'eficienta_energetica'];
const SUSPICION = ['suspiciune_neregula', 'suspiciune_frauda'];

/** The note field written under each section of the report (Anexa 6), by the section's number. */
const SECTION_NOTES: Array<[string, string]> = [
  ['1. ', 'contract_findings'],
  ['2.1 ', 'procurement_findings'],
  ['2.2 ', 'stage_findings'],
  ['2.3 ', 'indicators_findings'],
  ['2.4 ', 'equipment_findings'],
  ['2.5 ', 'works_findings'],
  ['2.6', 'deliverables_findings'],
  ['4. ', 'payments_findings'],
  ['II. ', 'durability_findings'],
  ['6. ', 'management_findings'],
  ['7. ', 'horizontal_findings'],
  ['8. ', 'visibility_findings'],
];
const noteOf = (section: string) => SECTION_NOTES.find(([p]) => section.startsWith(p))?.[1] ?? null;

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function useGps(active: boolean) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    if (!('geolocation' in navigator)) {
      setError('Dispozitivul nu oferă poziție GPS.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setFix({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() });
        setError(null);
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? 'Accesul la poziție a fost refuzat. Permiteți localizarea pentru acest site.' : 'Poziția GPS nu este disponibilă momentan.'),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);
  return { fix, error };
}

/** (measured − paid) / paid, in percent with one decimal; null when it cannot be computed. */
function difference(paid: unknown, measured: unknown): number | null {
  const p = Number(String(paid ?? '').replace(',', '.'));
  const m = Number(String(measured ?? '').replace(',', '.'));
  if (!paid || measured === null || measured === undefined || measured === '' || !Number.isFinite(p) || !Number.isFinite(m) || p <= 0) return null;
  return Math.round(((m - p) / p) * 1000) / 10;
}

interface ColumnSpec {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'choice' | 'textarea';
  options?: Array<{ code: string; label: string }>;
  readOnly?: boolean;
  placeholder?: string;
  /** Choice shown as a row of buttons (few options, tapped on site). */
  buttons?: boolean;
}

/** A table edited as one card per row: comfortable on a phone, readable on a tablet. */
function RowsEditor({
  name,
  rows,
  columns,
  editable,
  onChange,
  addLabel,
  rowTitle,
  rowExtra,
  empty,
}: {
  name: string;
  rows: Row[];
  columns: ColumnSpec[];
  editable: boolean;
  onChange: (rows: Row[]) => void;
  addLabel?: string;
  rowTitle?: (r: Row, i: number) => ReactNode;
  rowExtra?: (r: Row, i: number) => ReactNode;
  empty?: string;
}) {
  const set = (i: number, key: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  return (
    <div className="rows-editor">
      {rows.length === 0 && <div className="small muted">{empty ?? 'Niciun rând.'}</div>}
      {rows.map((r, i) => (
        <div key={i} className="row-card" role="group" aria-label={`${name}, rândul ${i + 1}`}>
          <div className="row-card-head">
            <strong>{rowTitle ? rowTitle(r, i) : `${i + 1}.`}</strong>
            {editable && addLabel && (
              <button type="button" className="link small danger-text" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Șterge rândul ${i + 1} din ${name}`}>
                șterge
              </button>
            )}
          </div>
          <div className="row-card-grid">
            {columns.map((c) => {
              const label = `${c.label}, rândul ${i + 1}`;
              const value = r[c.key] ?? '';
              const ro = !editable || c.readOnly;
              if (ro) {
                const shown = c.type === 'choice' ? (c.options?.find((o) => o.code === value)?.label ?? value) : c.type === 'date' && value ? fmtDate(value) : value;
                return (
                  <div key={c.key} className={c.type === 'textarea' ? 'wide' : ''}>
                    <span className="label">{c.label}</span>
                    <div>{shown === '' || shown === null ? '—' : String(shown)}</div>
                  </div>
                );
              }
              if (c.type === 'choice' && c.buttons) {
                return (
                  <div key={c.key} className="wide">
                    <span className="label">{c.label}</span>
                    <div className="chip-group" role="group" aria-label={label}>
                      {c.options?.map((o) => (
                        <button key={o.code} type="button" className={`chip ${value === o.code ? `sel ${o.code}` : ''}`} aria-pressed={value === o.code} onClick={() => set(i, c.key, value === o.code ? null : o.code)}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <label key={c.key} className={c.type === 'textarea' ? 'wide' : ''}>
                  <span className="label">{c.label}</span>
                  {c.type === 'choice' ? (
                    <select className="field-input" aria-label={label} value={value} onChange={(e) => set(i, c.key, e.target.value || null)}>
                      <option value="">—</option>
                      {c.options?.map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : c.type === 'textarea' ? (
                    <textarea className="field-input" aria-label={label} rows={2} value={value} placeholder={c.placeholder} onChange={(e) => set(i, c.key, e.target.value)} />
                  ) : (
                    <input
                      className="field-input"
                      aria-label={label}
                      type={c.type === 'date' ? 'date' : 'text'}
                      inputMode={c.type === 'number' ? 'decimal' : undefined}
                      value={value}
                      placeholder={c.placeholder}
                      onChange={(e) => set(i, c.key, c.type === 'date' ? e.target.value || null : e.target.value)}
                    />
                  )}
                </label>
              );
            })}
          </div>
          {rowExtra?.(r, i)}
        </div>
      ))}
      {editable && addLabel && (
        <button type="button" className="small" onClick={() => onChange([...rows, {}])}>
          + {addLabel}
        </button>
      )}
    </div>
  );
}

export function FieldVisit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const [snap, setSnap] = useState<FieldSnapshot | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [queue, setQueue] = useState<QueuedOp[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [answers, setAnswers] = useState<Record<string, Record<string, Answer>>>({});
  const [tab, setTab] = useState<Tab | null>(null);
  const [caption, setCaption] = useState('');
  const [photoSection, setPhotoSection] = useState('');
  const [signature, setSignature] = useState<Blob | null>(null);
  const [signerName, setSignerName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string; list?: string[] } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [hints, setHints] = useState<Set<string>>(new Set());
  const [obsOpen, setObsOpen] = useState<Set<string>>(new Set());
  const photoInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  // What the next photo is about: section and caption, set by the button that opened the camera.
  const nextPhoto = useRef<{ section?: string; caption?: string }>({});
  const fieldTimer = useRef<number | null>(null);
  const unsent = useRef<Record<string, unknown>>({});
  const listTimers = useRef<Record<string, number>>({});

  const reloadQueue = useCallback(async () => setQueue(await pending(id)), [id]);

  /** Loads the dossier from the server when online (and keeps a copy), otherwise from the device. */
  const load = useCallback(async () => {
    let s: FieldSnapshot | undefined;
    if (navigator.onLine) {
      try {
        const [dossier, evidence, context, ...noms] = await Promise.all([
          api.get(`/instances/${id}`),
          api.get(`/instances/${id}/evidence`),
          api.get(`/instances/${id}/visit-context`),
          ...NOMENCLATURES.map((k) => api.get(`/nomenclatures/${k}`)),
        ]);
        const nomenclatures = Object.fromEntries(NOMENCLATURES.map((k, i) => [k, noms[i].items]));
        // The previous visit's photos are kept as files, to compare angles without signal.
        const previousPhotos: Record<string, Blob> = {};
        const prev = (context.previous ?? []).flatMap((v: any) => v.photos).slice(0, 12);
        await Promise.all(
          prev.map(async (p: any) => {
            const r = await fetch(p.url).catch(() => null);
            if (r?.ok) previousPhotos[p.id] = await r.blob();
          }),
        );
        s = { dossier, evidence: evidence.items, results: nomenclatures.visit_result, nomenclatures, context, previousPhotos, savedAt: new Date().toISOString() };
        await saveSnapshot(id, s);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 0) setLoadError(err);
      }
    }
    s ??= await loadSnapshot(id);
    const q = await pending(id);
    setQueue(q);
    setSnap(s ?? null);
    if (!s) return;
    // Values: the server's, with the changes not yet sent on top.
    const base: Record<string, any> = Object.fromEntries(s.dossier.fields.map((f: any) => [f.key, f.value]));
    for (const op of q) {
      if (op.kind === 'fields') Object.assign(base, op.fields);
      if (op.kind === 'list') base[op.listKey] = op.rows;
    }
    const t = s.dossier.tasks.find((x: any) => x.canAct && x.evidence);
    if (!base.visit_date && t) {
      base.visit_date = todayIso();
      // The date shown by default must also reach the server, or the report is refused for a missing date.
      if (s.dossier.fields.some((f: any) => f.key === 'visit_date' && ['editable', 'required'].includes(f.access))) {
        await enqueue({ instanceId: id, kind: 'fields', taskId: t.id, fields: { visit_date: base.visit_date }, createdAt: new Date().toISOString() });
        setQueue(await pending(id));
      }
    }
    setValues(base);
    const a: Record<string, Record<string, Answer>> = {};
    for (const cl of s.dossier.checklists) {
      a[cl.key] = {};
      for (const item of cl.items) a[cl.key]![item.code] = { answer: item.responses.primary?.answer ?? null, observation: item.responses.primary?.observation ?? '' };
    }
    for (const op of q) if (op.kind === 'checklist') for (const r of op.responses) (a[op.checklistKey] ??= {})[r.code] = { answer: r.answer, observation: r.observation ?? '' };
    setAnswers(a);
    setSignerName((n) => n || base.representative || '');
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = useCallback(async () => {
    if (!navigator.onLine || syncing) return;
    setSyncing(true);
    try {
      const r = await flush(id);
      if (r.sent > 0) await load();
      else await reloadQueue();
    } finally {
      setSyncing(false);
    }
  }, [id, load, reloadQueue, syncing]);

  // Send what is waiting as soon as the signal returns, and every 30 s while something waits.
  useEffect(() => {
    if (online) void sync();
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!online || !queue.some((q) => !q.error)) return;
    const t = window.setInterval(() => void sync(), 30_000);
    return () => window.clearInterval(t);
  }, [online, queue, sync]);

  const isFieldTask = (t: any) => t.evidence || t.stepKey === 'prepare';
  const task = useMemo(() => snap?.dossier.tasks.find((t: any) => t.canAct && isFieldTask(t)) ?? null, [snap]);
  const queued = useMemo(() => snap?.dossier.tasks.find((t: any) => isFieldTask(t) && !t.assignee) ?? null, [snap]);
  const phase: 'prepare' | 'visit' | null = task ? (task.stepKey === 'prepare' ? 'prepare' : 'visit') : null;
  const fieldDefs = useMemo(() => Object.fromEntries((snap?.dossier.fields ?? []).map((f: any) => [f.key, f])), [snap]);
  const gps = useGps(phase === 'visit');

  useEffect(() => {
    if (snap && tab === null) setTab(phase === 'visit' ? 'verify' : snap.dossier.status === 'active' && phase === 'prepare' ? 'prepare' : phase ? 'verify' : 'prepare');
  }, [snap, phase, tab]);

  if (snap === undefined) return <Loading />;
  if (!snap) {
    return (
      <div className="field-page">
        <ErrorAlert error={loadError ?? new Error('Dosarul nu a fost descărcat pe acest dispozitiv. Deschideți-l o dată cu semnal, apoi îl puteți folosi și fără.')} />
        <Link to="/vizite">Înapoi la vizite</Link>
      </div>
    );
  }
  const d = snap.dossier;
  const noms = snap.nomenclatures ?? { visit_result: snap.results };
  const opts = (key: string) => noms[key] ?? [];
  const labelOf = (nom: string, code: unknown) => opts(nom).find((o) => o.code === code)?.label ?? (code ? String(code) : '—');
  const editable = (key: string) => Boolean(task) && ['editable', 'required'].includes(fieldDefs[key]?.access);
  const shown = (key: string) => Boolean(fieldDefs[key]);
  const required = (key: string) => fieldDefs[key]?.access === 'required';
  const waiting = queue.filter((q) => !q.error);
  const refused = queue.filter((q) => q.error);
  const works = WORKS_KINDS.includes(values.project_kind);
  const rows = (key: string): Row[] => (Array.isArray(values[key]) ? values[key] : []);

  const setField = (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (!task) return;
    if (fieldTimer.current) window.clearTimeout(fieldTimer.current);
    unsent.current[key] = value;
    // Short pause so typing does not create one change per letter; edits to several fields are kept together.
    fieldTimer.current = window.setTimeout(async () => {
      const fields = unsent.current;
      unsent.current = {};
      await enqueue({ instanceId: id, kind: 'fields', taskId: task.id, fields, createdAt: new Date().toISOString() });
      await reloadQueue();
      void sync();
    }, 700);
  };

  const setList = (key: string, next: Row[]) => {
    setValues((v) => ({ ...v, [key]: next }));
    if (!task || !editable(key)) return;
    window.clearTimeout(listTimers.current[key]);
    listTimers.current[key] = window.setTimeout(async () => {
      // Empty cards (just added) are not sent; calculated columns are recomputed by the server.
      const clean = next.filter((r) => Object.values(r).some((v) => v !== null && v !== undefined && v !== '')).map(({ difference: _d, ...r }) => r);
      await enqueue({ instanceId: id, kind: 'list', taskId: task.id, listKey: key, rows: clean, createdAt: new Date().toISOString() });
      await reloadQueue();
      void sync();
    }, 700);
  };

  const checklistEditable = (key: string) => (key === 'prepare' ? phase === 'prepare' : phase === 'visit');
  const setAnswer = async (key: string, code: string, patch: Partial<Answer>) => {
    const cur = answers[key] ?? {};
    const nextForKey = { ...cur, [code]: { ...(cur[code] ?? { answer: null, observation: '' }), ...patch } };
    setAnswers((a) => ({ ...a, [key]: nextForKey }));
    if (!task || !checklistEditable(key)) return;
    await enqueue({
      instanceId: id,
      kind: 'checklist',
      taskId: task.id,
      checklistKey: key,
      responses: Object.entries(nextForKey)
        .filter(([, a]) => a.answer)
        .map(([c, a]) => ({ code: c, answer: a.answer, observation: a.observation || null })),
      createdAt: new Date().toISOString(),
    });
    await reloadQueue();
    void sync();
  };

  /** Uses the last GPS fix when recent, otherwise asks for one (at most 10 s). */
  const position = (): Promise<Fix | null> =>
    gps.fix && Date.now() - gps.fix.at < 120_000
      ? Promise.resolve(gps.fix)
      : new Promise((resolve) =>
          navigator.geolocation
            ? navigator.geolocation.getCurrentPosition(
                (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }),
                () => resolve(null),
                { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
              )
            : resolve(null),
        );

  const takePhoto = (o: { section?: string; caption?: string } = {}) => {
    nextPhoto.current = o;
    photoInput.current?.click();
  };

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length || phase !== 'visit') return;
    setBusy('photo');
    setMessage(null);
    const preset = nextPhoto.current;
    nextPhoto.current = {};
    try {
      for (const file of Array.from(files)) {
        const [blob, fix] = await Promise.all([compressPhoto(file), position()]);
        await enqueue({
          instanceId: id,
          kind: 'evidence',
          blob,
          meta: {
            kind: 'photo',
            clientId: newClientId(),
            caption: (preset.caption ?? caption).trim() || undefined,
            section: (preset.section ?? photoSection) || undefined,
            takenAt: new Date(file.lastModified && Date.now() - file.lastModified < 600_000 ? file.lastModified : Date.now()).toISOString(),
            ...(fix ? { latitude: Number(fix.latitude.toFixed(6)), longitude: Number(fix.longitude.toFixed(6)), accuracy: Math.round(fix.accuracy) } : {}),
          },
          createdAt: new Date().toISOString(),
        });
      }
      if (!preset.caption) setCaption('');
      await reloadQueue();
      setMessage({ tone: 'success', text: files.length > 1 ? `${files.length} fotografii salvate pe dispozitiv.` : 'Fotografie salvată pe dispozitiv.' });
      void sync();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
      if (photoInput.current) photoInput.current.value = '';
      if (galleryInput.current) galleryInput.current.value = '';
    }
  };

  const saveSignature = async () => {
    if (!signature || phase !== 'visit') return;
    const fix = await position();
    await enqueue({
      instanceId: id,
      kind: 'evidence',
      blob: signature,
      meta: {
        kind: 'signature',
        clientId: newClientId(),
        signerName: signerName.trim() || undefined,
        takenAt: new Date().toISOString(),
        ...(fix ? { latitude: Number(fix.latitude.toFixed(6)), longitude: Number(fix.longitude.toFixed(6)), accuracy: Math.round(fix.accuracy) } : {}),
      },
      createdAt: new Date().toISOString(),
    });
    setSignature(null);
    await reloadQueue();
    setMessage({ tone: 'success', text: 'Semnătura a fost salvată.' });
    void sync();
  };

  const deletePhoto = async (evidenceId: string) => {
    if (!window.confirm('Ștergeți fotografia din dosar?')) return;
    try {
      await api.del(`/instances/${id}/evidence/${evidenceId}`);
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.title : (err as Error).message });
    }
  };

  const claim = async () => {
    try {
      await api.post(`/tasks/${queued.id}/claim`);
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.title : (err as Error).message });
    }
  };

  const showError = (err: unknown) => {
    if (err instanceof ApiError) setMessage({ tone: 'error', text: err.title, list: err.errors.map((e) => e.message) });
    else setMessage({ tone: 'error', text: (err as Error).message });
  };

  /** Waits for typed changes to be queued, then sends everything. */
  const sendAll = async () => {
    await new Promise((r) => window.setTimeout(r, 800));
    await sync();
    if ((await pending(id)).length) throw new Error('Mai sunt modificări netrimise. Rezolvați-le înainte de a continua.');
  };

  const finishPreparation = async () => {
    if (!task) return;
    setBusy('ready');
    setMessage(null);
    try {
      await sendAll();
      await api.post(`/instances/${id}/transitions`, { taskId: task.id, path: 'ready' });
      setTab('verify');
      await load();
      setMessage({ tone: 'success', text: 'Pregătirea este completă. Dosarul este pe acest dispozitiv: îl puteți folosi pe teren și fără semnal.' });
      window.scrollTo(0, 0);
    } catch (err) {
      showError(err);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    if (!task) return;
    setBusy('finish');
    setMessage(null);
    try {
      await sendAll();
      await api.post(`/instances/${id}/documents/visit_report/sign`);
      await api.post(`/instances/${id}/transitions`, { taskId: task.id, path: 'submit' });
      navigate(`/dosare/${id}`);
    } catch (err) {
      showError(err);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const serverPhotos = snap.evidence.filter((e: any) => e.kind === 'photo');
  const serverSignature = snap.evidence.find((e: any) => e.kind === 'signature');
  const localPhotos = queue.filter((q): q is Extract<QueuedOp, { kind: 'evidence' }> => q.kind === 'evidence' && q.meta.kind === 'photo');
  const localSignature = queue.find((q): q is Extract<QueuedOp, { kind: 'evidence' }> => q.kind === 'evidence' && q.meta.kind === 'signature');
  const photosOf = (section: string) => serverPhotos.filter((p: any) => p.section === section).length + localPhotos.filter((p) => p.meta.section === section).length;
  const previous: any[] = snap.context?.previous ?? [];
  const lastVisit = previous[0];
  const previousPhotosOf = (section: string) => (lastVisit?.photos ?? []).filter((p: any) => p.section === section && snap.previousPhotos?.[p.id]);

  const checklist = (key: string) => d.checklists.find((c: any) => c.key === key);
  const applicable = (key: string): any[] => (checklist(key)?.items ?? []).filter((i: any) => i.applies !== false);
  const ans = (key: string, code: string): Answer => answers[key]?.[code] ?? { answer: null, observation: '' };
  const sectionsOf = (key: string) => {
    const out: Array<{ title: string; items: any[] }> = [];
    for (const i of applicable(key)) {
      const title = i.section ?? '';
      if (out.at(-1)?.title !== title) out.push({ title, items: [] });
      out.at(-1)!.items.push(i);
    }
    return out;
  };
  const onsiteSections = sectionsOf('onsite');
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const n = new Set(set);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    setter(n);
  };

  // What still stops the report, checked on the device (the server checks again on submission).
  const missing: string[] = [];
  if (phase === 'visit') {
    const unanswered = applicable('onsite').filter((i) => !ans('onsite', i.code).answer).length;
    if (unanswered) missing.push(`${unanswered} ${unanswered === 1 ? 'punct' : 'puncte'} din lista de verificare fără răspuns`);
    const noObs = applicable('onsite').filter((i) => {
      const a = ans('onsite', i.code);
      return a.answer && i.observationRequiredOn.includes(a.answer) && !a.observation.trim();
    }).length;
    if (noObs) missing.push(`${noObs} ${noObs === 1 ? 'răspuns' : 'răspunsuri'} fără observația obligatorie`);
    const eq = rows('equipment').filter((r) => !r.status).length;
    if (eq) missing.push(`${eq} ${eq === 1 ? 'echipament' : 'echipamente'} fără constatare`);
    const pr = rows('previous_recommendations').filter((r) => !r.status).length;
    if (pr) missing.push(`${pr} ${pr === 1 ? 'recomandare anterioară' : 'recomandări anterioare'} fără stadiu`);
    const dm = rows('documents_checked').filter((r) => !r.method).length;
    if (dm) missing.push(`metoda de verificare la ${dm} ${dm === 1 ? 'document' : 'documente'}`);
    if (!rows('beneficiary_participants').length) missing.push('participanții din partea beneficiarului');
    if (!values.representative) missing.push('reprezentantul care semnează');
    if (serverPhotos.length + localPhotos.length === 0) missing.push('cel puțin o fotografie');
    if (!serverSignature && !localSignature) missing.push('semnătura reprezentantului');
    if (values.visit_reason !== 'ex_post' && !values.stage_findings) missing.push('constatările la punctul 2.2 (stadiul activităților)');
    if (values.visit_reason === 'ex_post' && !values.durability_findings) missing.push('constatările privind durabilitatea');
    if (!values.findings) missing.push('concluziile (punctul 11)');
    if (!values.deviation_type) missing.push('natura abaterilor');
    if (!values.result) missing.push('rezultatul verificării');
    if (values.result && values.result !== 'conform' && !rows('recommendations').length) missing.push('cel puțin o recomandare (punctul 12)');
    if (rows('recommendations').some((r) => !r.recommendation || !r.deadline || !r.evidence_required)) missing.push('termenul sau dovada cerută la o recomandare');
    if (values.result === 'neconform' && !SUSPICION.includes(values.deviation_type)) missing.push('„neconform” presupune o suspiciune de neregulă sau fraudă');
    if (SUSPICION.includes(values.deviation_type) && values.result !== 'neconform') missing.push('o suspiciune de neregulă sau fraudă cere rezultatul „neconform”');
  }

  const textField = (key: string, opt: { rows?: number; placeholder?: string; label?: string } = {}) =>
    shown(key) ? (
      <label key={key} className="field">
        <span className="label">
          {opt.label ?? fieldDefs[key].label}
          {required(key) ? ' *' : ''}
        </span>
        {fieldDefs[key].type === 'textarea' ? (
          <textarea className="field-input" rows={opt.rows ?? 3} placeholder={opt.placeholder} value={values[key] ?? ''} disabled={!editable(key)} onChange={(e) => setField(key, e.target.value)} />
        ) : (
          <input
            className="field-input"
            type={fieldDefs[key].type === 'date' ? 'date' : 'text'}
            value={values[key] ?? ''}
            disabled={!editable(key)}
            onChange={(e) => {
              setField(key, e.target.value || null);
              if (key === 'representative' && !signerName) setSignerName(e.target.value);
            }}
          />
        )}
      </label>
    ) : null;

  const choiceField = (key: string, nom: string, help?: ReactNode) =>
    shown(key) ? (
      <label key={key} className="field">
        <span className="label">
          {fieldDefs[key].label}
          {required(key) ? ' *' : ''}
        </span>
        <select className="field-input" value={values[key] ?? ''} disabled={!editable(key)} onChange={(e) => setField(key, e.target.value || null)}>
          <option value="">— alegeți —</option>
          {opts(nom).map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
        {help && <span className="small muted">{help}</span>}
      </label>
    ) : null;

  const checklistItems = (key: string, items: any[]) => {
    const cl = checklist(key);
    const can = Boolean(task) && checklistEditable(key);
    return items.map((item: any) => {
      const a = ans(key, item.code);
      const needsObs = a.answer && item.observationRequiredOn.includes(a.answer);
      const k = `${key}:${item.code}`;
      return (
        <div key={item.code} className="field-q">
          <div className="field-q-text">
            <span className="muted">{item.code}.</span> {item.question}
            {item.hint && (
              <button type="button" className="hint-btn" aria-expanded={hints.has(k)} aria-label={`Îndrumare la punctul ${item.code}`} onClick={() => toggle(hints, setHints, k)}>
                i
              </button>
            )}
          </div>
          {item.hint && hints.has(k) && <div className="field-hint-box small">{item.hint}</div>}
          <div className="field-answers" role="group" aria-label={`Răspuns la punctul ${item.code}`}>
            {cl.answerSet.map((opt: string) => (
              <button key={opt} type="button" className={a.answer === opt ? `sel ${opt.toLowerCase()}` : ''} aria-pressed={a.answer === opt} disabled={!can} onClick={() => setAnswer(key, item.code, { answer: opt })}>
                {opt === 'DA' ? 'Da' : opt === 'NU' ? 'Nu' : 'N/A'}
              </button>
            ))}
          </div>
          {(needsObs || a.observation || obsOpen.has(k)) && (
            <textarea
              aria-label={`Observație la punctul ${item.code}`}
              placeholder={needsObs ? 'Observație obligatorie' : 'Observație'}
              value={a.observation}
              disabled={!can}
              onChange={(e) => setAnswers((x) => ({ ...x, [key]: { ...x[key], [item.code]: { ...a, observation: e.target.value } } }))}
              onBlur={(e) => setAnswer(key, item.code, { observation: e.target.value })}
              className={needsObs && !a.observation ? 'invalid' : ''}
            />
          )}
          {!needsObs && !a.observation && !obsOpen.has(k) && a.answer && can && (
            <button type="button" className="link small" onClick={() => toggle(obsOpen, setObsOpen, k)}>
              + observație
            </button>
          )}
        </div>
      );
    });
  };

  const sectionPhotoButton = (section: string, label = 'Fotografie pentru această secțiune') =>
    phase === 'visit' && (
      <div className="section-photo">
        <button type="button" className="small" onClick={() => takePhoto({ section })} disabled={busy === 'photo'}>
          📷 {label}
        </button>
        <span className="small muted">{photosOf(section)} foto</span>
      </div>
    );

  const sameAngle = (section: string) => {
    const prev = previousPhotosOf(section);
    if (!prev.length || phase !== 'visit') return null;
    return (
      <div className="same-angle">
        <div className="small muted">
          Vizita anterioară ({lastVisit.visit_date ? fmtDate(lastVisit.visit_date) : '—'}): fotografiați din același unghi
        </div>
        <div className="same-angle-row">
          {prev.map((p: any) => (
            <PrevThumb
              key={p.id}
              blob={snap.previousPhotos![p.id]!}
              caption={p.caption}
              onRetake={() => takePhoto({ section, caption: `Același unghi ca la ${lastVisit.visit_date ? fmtDate(lastVisit.visit_date) : 'vizita anterioară'}${p.caption ? `: ${p.caption}` : ''}` })}
            />
          ))}
        </div>
      </div>
    );
  };

  const sectionExtras = (title: string) => {
    if (title.startsWith('2.2 ') && values.declared_progress)
      return (
        <div className="field-callout small">
          <strong>Beneficiarul a declarat:</strong> {values.declared_progress}
        </div>
      );
    if (title.startsWith('2.3 ') && values.stage_indicators_due)
      return (
        <div className="field-callout small">
          <strong>Indicatori de etapă scadenți:</strong> {values.stage_indicators_due}
        </div>
      );
    if (title.startsWith('2.4 ') && shown('equipment'))
      return (
        <div className="field-sub">
          <h3>Echipamentele din facturi ({rows('equipment').filter((r) => r.status).length}/{rows('equipment').length} verificate)</h3>
          <RowsEditor
            name="Echipamente"
            rows={rows('equipment')}
            editable={editable('equipment')}
            onChange={(r) => setList('equipment', r)}
            addLabel="Echipament găsit care nu era în listă"
            rowTitle={(r, i) => `${i + 1}. ${r.item || 'Echipament'}${r.quantity ? ` × ${r.quantity}` : ''}`}
            columns={[
              { key: 'serial_expected', label: 'Seria din factură / PV', readOnly: phase === 'visit' && Boolean(snap.dossier.fields) },
              { key: 'placement', label: 'Amplasare', readOnly: true },
              { key: 'status', label: 'Constatare', type: 'choice', options: opts('equipment_status'), buttons: true },
              { key: 'serial_found', label: 'Seria găsită' },
              { key: 'observation', label: 'Observații', type: 'textarea' },
            ]}
            rowExtra={(r) =>
              phase === 'visit' ? (
                <button type="button" className="small" style={{ marginTop: 6 }} onClick={() => takePhoto({ section: title, caption: `${r.item ?? 'Echipament'}, seria ${r.serial_found || r.serial_expected || '—'}` })}>
                  📷 Fotografiază echipamentul și seria
                </button>
              ) : null
            }
            empty="Lista de echipamente nu a fost întocmită la pregătire."
          />
        </div>
      );
    if (title.startsWith('2.5 ') && shown('works_sampling'))
      return (
        <div className="field-sub">
          <h3>Măsurători prin sondaj</h3>
          <p className="small muted">Alegeți 2–3 poziții din situațiile de lucrări decontate și măsurați-le.</p>
          <RowsEditor
            name="Măsurători"
            rows={rows('works_sampling')}
            editable={editable('works_sampling')}
            onChange={(r) => setList('works_sampling', r)}
            addLabel="Poziție măsurată"
            rowTitle={(r, i) => `${r.position || i + 1}. ${r.description ?? ''}`}
            columns={[
              { key: 'position', label: 'Poziția' },
              { key: 'description', label: 'Descriere' },
              { key: 'unit', label: 'UM' },
              { key: 'qty_paid', label: 'Cantitate decontată', type: 'number' },
              { key: 'qty_measured', label: 'Cantitate măsurată', type: 'number' },
            ]}
            rowExtra={(r) => {
              const diff = difference(r.qty_paid, r.qty_measured);
              return diff === null ? null : (
                <div className={`diff ${Math.abs(diff) > 5 ? 'bad' : 'ok'}`}>
                  Diferență: {diff > 0 ? '+' : ''}
                  {String(diff).replace('.', ',')}% față de decontat
                </div>
              );
            }}
          />
        </div>
      );
    if (title.startsWith('5. ') && shown('previous_recommendations'))
      return (
        <div className="field-sub">
          <RowsEditor
            name="Recomandări anterioare"
            rows={rows('previous_recommendations')}
            editable={editable('previous_recommendations')}
            onChange={(r) => setList('previous_recommendations', r)}
            rowTitle={(r, i) => `${i + 1}. ${r.recommendation ?? ''}`}
            columns={[
              { key: 'deadline', label: 'Termen', type: 'date', readOnly: true },
              { key: 'evidence_required', label: 'Dovada cerută', readOnly: true },
              { key: 'status', label: 'Stadiu constatat', type: 'choice', options: opts('recommendation_status'), buttons: true },
              { key: 'observation', label: 'Observații', type: 'textarea' },
            ]}
            empty="Nu există recomandări dintr-o vizită anterioară: răspundeți N/A."
          />
        </div>
      );
    if (title.startsWith('8. ') && values.visibility_requirement)
      return (
        <div className="field-callout small">
          <strong>Cerința pentru acest proiect:</strong> {values.visibility_requirement}
        </div>
      );
    if (title.startsWith('Încheierea'))
      return (
        <div className="field-sub">
          {textField('beneficiary_position', { placeholder: 'Ce spune beneficiarul despre constatări' })}
          {textField('missing_documents', { placeholder: 'Documente lipsă, de încărcat în MySMIS, cu termen' })}
        </div>
      );
    return null;
  };

  const tabs: Array<[Tab, string]> = [
    ['prepare', '1 · Pregătesc'],
    ['verify', '2 · Verific'],
    ['report', '3 · Raportez'],
    ['guide', 'Ghid'],
  ];
  const prepareRows = (key: string) => (phase === 'prepare' ? editable(key) : false);

  return (
    <div className="field-page">
      <header className="field-head">
        <Link to={`/dosare/${id}`} className="field-back" aria-label="Înapoi la dosar">
          ←
        </Link>
        <div className="field-title">
          <div className="small">{values.visit_reason ? labelOf('visit_reason', values.visit_reason) : 'Verificare la fața locului'}</div>
          <strong>{d.beneficiary?.name ?? d.title}</strong>
          <div className="small">SMIS {d.project?.smis_code}</div>
        </div>
        <span className={`net ${online ? 'on' : 'off'}`}>{online ? 'online' : 'fără semnal'}</span>
      </header>

      <div className={`sync-bar ${waiting.length ? 'wait' : 'ok'}`} role="status">
        {waiting.length ? (
          <>
            <span>
              {waiting.length} {waiting.length === 1 ? 'modificare' : 'modificări'} pe dispozitiv{online ? '' : ' – se trimit când revine semnalul'}
            </span>
            {online && (
              <button className="small" onClick={() => void sync()} disabled={syncing}>
                {syncing ? 'Se trimit…' : 'Trimite acum'}
              </button>
            )}
          </>
        ) : (
          <span>Totul este salvat pe server{snap.savedAt ? ` · actualizat ${fmtDateTime(snap.savedAt)}` : ''}</span>
        )}
      </div>

      <nav className="field-tabs" aria-label="Etapele vizitei">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'active' : ''} aria-current={tab === k ? 'step' : undefined} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      {refused.length > 0 && (
        <div className="alert error small">
          <strong>Serverul a refuzat {refused.length === 1 ? 'o modificare' : `${refused.length} modificări`}:</strong>
          {refused.map((op) => (
            <div key={op.id} className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <span>
                {op.kind === 'evidence' ? (op.meta.kind === 'photo' ? 'Fotografie' : 'Semnătură') : op.kind === 'fields' ? 'Date' : op.kind === 'list' ? 'Tabel' : 'Listă de verificare'}: {op.error}
              </span>
              <span className="row" style={{ gap: 4 }}>
                <button className="small" onClick={async () => (await retryOp(op), await reloadQueue(), void sync())}>
                  Reîncearcă
                </button>
                <button className="small" onClick={async () => (await removeOp(op.id!), await reloadQueue())}>
                  Renunță
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {message && (
        <div className={`alert ${message.tone} small`}>
          {message.text}
          {message.list?.length ? (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {message.list.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {(task || queued) && d.status === 'active' && online && <CoiBanner instanceId={id} coi={d.coi} onDeclared={() => void load()} />}
      {queued && online && !(d.coi.required && !d.coi.declared) && (
        <div className="alert info">
          Vizita este în coada experților de monitorizare; preluați-o ca să apară pe numele dvs.{' '}
          <button className="primary small" onClick={claim}>
            Preiau vizita
          </button>
        </div>
      )}
      {!task && !queued && (
        <div className="alert info small">
          Dosarul nu este la pregătire sau la vizită ori nu vă este repartizat; pagina este doar pentru consultare. <Link to={`/dosare/${id}`}>Deschide dosarul</Link>
        </div>
      )}

      {/* ------------------------------------------------------------------ PREGĂTESC */}
      {tab === 'prepare' && (
        <>
          <section className="field-card">
            <h2>Vizita</h2>
            <dl className="field-dl">
              <dt>Tip</dt>
              <dd>{labelOf('visit_reason', values.visit_reason)}</dd>
              <dt>Investiția</dt>
              <dd>{labelOf('visit_project_kind', values.project_kind)}</dd>
              <dt>Scopul</dt>
              <dd>{values.visit_scope ?? '—'}</dd>
              <dt>Programată</dt>
              <dd>{values.planned_date ? fmtDate(values.planned_date) : '—'}</dd>
              <dt>Locul</dt>
              <dd>
                {values.location ?? '—'}
                {values.location && (
                  <>
                    {' '}
                    ·{' '}
                    <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(values.location)}`} target="_blank" rel="noreferrer">
                      hartă
                    </a>
                  </>
                )}
              </dd>
              <dt>Contact</dt>
              <dd>{values.beneficiary_contact ?? '—'}</dd>
              <dt>Contract</dt>
              <dd>
                {values.contract_number ?? '—'}
                {snap.context?.project?.total_value ? ` · ${fmtAmount(snap.context.project.total_value)} lei` : ''}
              </dd>
              <dt>Verificat</dt>
              <dd>{values.sampled_reference ?? '—'}</dd>
            </dl>
            {['ad_hoc', 'suspiciune'].includes(values.visit_reason) && <div className="field-callout small">Vizită inopinată: beneficiarul nu este notificat în prealabil.</div>}
          </section>

          {phase === 'prepare' && (
            <div className="field-callout small">
              Regula de aur: știți <strong>ce ar trebui să vedeți</strong>, <strong>ce a declarat beneficiarul</strong> și <strong>unde este riscul cel mai mare</strong>.
            </div>
          )}

          <section className="field-card">
            <h2>Echipa de verificare</h2>
            <RowsEditor
              name="Echipa"
              rows={rows('team')}
              editable={prepareRows('team')}
              onChange={(r) => setList('team', r)}
              addLabel="Membru în echipă"
              columns={[
                { key: 'name', label: 'Nume și prenume' },
                { key: 'role', label: 'Calitatea', type: 'choice', options: opts('visit_team_role') },
              ]}
              empty="Adăugați membrii echipei (ofițer de monitorizare, expert achiziții, ofițer autorizare plăți)."
            />
          </section>

          <section className="field-card">
            <h2>Ce urmăresc</h2>
            {textField('declared_progress', { placeholder: 'Stadiul și indicatorii declarați în ultimul raport de progres' })}
            {values.visit_reason !== 'ex_post' && textField('stage_indicators_due', { placeholder: 'Indicatorii de etapă din planul de monitorizare, cu termenele' })}
            {textField('main_risk', { placeholder: 'De ex. echipamentele din CR 3, lucrările ascunse, panoul' })}
          </section>

          {shown('equipment') && (
            <section className="field-card">
              <h2>Lista echipamentelor (din facturi și PV de recepție)</h2>
              <RowsEditor
                name="Lista echipamentelor"
                rows={rows('equipment')}
                editable={prepareRows('equipment')}
                onChange={(r) => setList('equipment', r)}
                addLabel="Echipament"
                rowTitle={(r, i) => `${i + 1}. ${r.item || ''}`}
                columns={[
                  { key: 'item', label: 'Denumire' },
                  { key: 'quantity', label: 'Cantitate', type: 'number' },
                  { key: 'serial_expected', label: 'Seria din factură / PV' },
                  { key: 'invoice', label: 'Factura / PV recepție' },
                  { key: 'placement', label: 'Amplasare' },
                ]}
                empty="Nicio poziție. Întocmiți lista din facturi și procesele-verbale de recepție."
              />
            </section>
          )}

          {works && shown('works_sampling') && (
            <section className="field-card">
              <h2>Poziții de măsurat (situații de lucrări)</h2>
              <RowsEditor
                name="Poziții de măsurat"
                rows={rows('works_sampling')}
                editable={prepareRows('works_sampling')}
                onChange={(r) => setList('works_sampling', r)}
                addLabel="Poziție"
                columns={[
                  { key: 'position', label: 'Poziția' },
                  { key: 'description', label: 'Descriere' },
                  { key: 'unit', label: 'UM' },
                  { key: 'qty_paid', label: 'Cantitate decontată', type: 'number' },
                ]}
                empty="Alegeți 2–3 poziții cu valoare mare sau greu de verificat ulterior (lucrări ascunse)."
              />
            </section>
          )}

          <section className="field-card">
            <h2>Vizita anterioară</h2>
            {lastVisit ? (
              <>
                <p className="small" style={{ marginTop: 0 }}>
                  {lastVisit.visit_date ? fmtDate(lastVisit.visit_date) : '—'} · {lastVisit.visit_reason_label ?? ''} · {lastVisit.result_label ?? 'în curs'} · {lastVisit.inspector ?? ''}
                </p>
                {rows('previous_recommendations').length > 0 ? (
                  <ul className="small" style={{ paddingLeft: '1.1rem' }}>
                    {rows('previous_recommendations').map((r, i) => (
                      <li key={i}>
                        {r.recommendation} {r.deadline ? `– termen ${fmtDate(r.deadline)}` : ''}
                        {r.evidence_required ? ` (dovadă: ${r.evidence_required})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="small muted">Fără recomandări.</p>
                )}
                {lastVisit.photos.length > 0 && <div className="small muted">{lastVisit.photos.length} fotografii, de refăcut din aceleași unghiuri (le găsiți în fiecare secțiune la „Verific”).</div>}
              </>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                Prima vizită la acest proiect.
              </p>
            )}
          </section>

          {checklist('prepare') && (
            <section className="field-card">
              <h2>
                Lista de pregătire{' '}
                <span className="muted small">
                  {applicable('prepare').filter((i) => ans('prepare', i.code).answer).length}/{applicable('prepare').length}
                </span>
              </h2>
              {checklistItems('prepare', applicable('prepare'))}
            </section>
          )}

          {phase === 'prepare' && (
            <section className="field-card">
              <h2>Gata de plecare</h2>
              <p className="small muted">Dosarul, listele și fotografiile vizitei anterioare rămân pe dispozitiv: pe teren puteți lucra și fără semnal.</p>
              <button className="primary big" disabled={!online || busy === 'ready'} onClick={() => void finishPreparation()}>
                {busy === 'ready' ? 'Se trimite…' : 'Pregătirea este completă – plec pe teren'}
              </button>
            </section>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ VERIFIC */}
      {tab === 'verify' && (
        <>
          {phase === 'prepare' && <div className="alert info small">Secțiunile se completează pe teren, după ce încheiați pregătirea.</div>}
          <section className="field-card">
            <h2>Deschiderea vizitei</h2>
            <p className="small muted" style={{ marginTop: 0 }}>
              Prezentați echipa și traseul vizitei. Corespondența oficială se face doar prin MySMIS; nu acceptați cadouri, mese sau transport.
            </p>
            {textField('visit_date')}
            {shown('beneficiary_participants') && (
              <div className="field">
                <span className="label">Participanți din partea beneficiarului{required('beneficiary_participants') ? ' *' : ''}</span>
                <RowsEditor
                  name="Participanți"
                  rows={rows('beneficiary_participants')}
                  editable={editable('beneficiary_participants')}
                  onChange={(r) => setList('beneficiary_participants', r)}
                  addLabel="Participant"
                  columns={[
                    { key: 'name', label: 'Nume și prenume' },
                    { key: 'function', label: 'Funcția' },
                  ]}
                />
              </div>
            )}
            {textField('representative')}
            {textField('representative_role')}
            {phase === 'visit' && <div className={`gps ${gps.fix ? 'ok' : 'none'}`}>{gps.fix ? <>Poziția dvs.: {gpsLabel({ latitude: gps.fix.latitude, longitude: gps.fix.longitude, accuracy_m: gps.fix.accuracy })}</> : (gps.error ?? 'Se caută poziția GPS…')}</div>}
            {values.main_risk && (
              <div className="field-callout small">
                <strong>Riscul principal stabilit la pregătire:</strong> {values.main_risk}
              </div>
            )}
          </section>

          {checklist('onsite') && (
            <>
              <div className="row" style={{ justifyContent: 'space-between', margin: '0 0 0.5rem' }}>
                <strong>
                  Lista de verificare{' '}
                  <span className="muted small">
                    {applicable('onsite').filter((i) => ans('onsite', i.code).answer).length}/{applicable('onsite').length}
                  </span>
                </strong>
                <button type="button" className="link small" onClick={() => setOpen(open.size ? new Set() : new Set(onsiteSections.map((s) => s.title)))}>
                  {open.size ? 'Închide secțiunile' : 'Deschide toate secțiunile'}
                </button>
              </div>
              {onsiteSections.map((s) => {
                const done = s.items.filter((i) => ans('onsite', i.code).answer).length;
                const nu = s.items.some((i) => ans('onsite', i.code).answer === 'NU');
                const isOpen = open.has(s.title);
                const note = noteOf(s.title);
                return (
                  <section key={s.title} className={`field-card field-section ${done === s.items.length ? 'complete' : ''}`}>
                    <button type="button" className="section-toggle" aria-expanded={isOpen} onClick={() => toggle(open, setOpen, s.title)}>
                      <span>{s.title}</span>
                      <span className="small">
                        {nu && <span className="tag err">NU</span>}
                        {done}/{s.items.length}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="section-body">
                        {checklistItems('onsite', s.items)}
                        {sectionExtras(s.title)}
                        {note && shown(note) && textField(note, { label: 'Constatări la această secțiune', rows: 3 })}
                        {sameAngle(s.title)}
                        {sectionPhotoButton(s.title)}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          )}

          <section className="field-card">
            <h2>
              Fotografii <span className="muted small">{serverPhotos.length + localPhotos.length}</span>
            </h2>
            {phase === 'visit' && (
              <>
                <input className="field-input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Descriere (opțional), ex. Utilaj CNC, seria 4471" aria-label="Descrierea fotografiei" />
                <select className="field-input" style={{ marginTop: 8 }} value={photoSection} onChange={(e) => setPhotoSection(e.target.value)} aria-label="Secțiunea raportului">
                  <option value="">Secțiunea raportului (opțional)</option>
                  {onsiteSections.map((s) => (
                    <option key={s.title} value={s.title}>
                      {s.title}
                    </option>
                  ))}
                </select>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="primary big" onClick={() => takePhoto()} disabled={busy === 'photo'}>
                    {busy === 'photo' ? 'Se salvează…' : 'Fă o fotografie'}
                  </button>
                  <button className="big" onClick={() => galleryInput.current?.click()} disabled={busy === 'photo'}>
                    Din galerie
                  </button>
                </div>
                <p className="small muted">Fotografiați lucrările și echipamentele, nu persoanele (GDPR). Panoul: cu ruleta, ca să se vadă dimensiunea.</p>
              </>
            )}
            <div className="field-photos">
              {localPhotos.map((op) => (
                <LocalThumb key={op.id} op={op} onRemove={async () => (await removeOp(op.id!), await reloadQueue())} />
              ))}
              {serverPhotos.map((p: any) => (
                <figure key={p.id} className="field-photo">
                  <img src={p.url} alt={p.caption ?? 'Fotografie'} loading="lazy" />
                  <figcaption>
                    {p.section && <div className="muted">{p.section}</div>}
                    {p.caption && <strong>{p.caption}</strong>}
                    <div>{p.taken_at ? fmtDateTime(p.taken_at) : ''}</div>
                    <div>
                      {gpsLabel(p) ? (
                        <a href={mapLink(p.latitude, p.longitude)} target="_blank" rel="noreferrer">
                          GPS {gpsLabel(p)}
                        </a>
                      ) : (
                        'fără GPS'
                      )}
                    </div>
                    <span className="tag ok">pe server</span>
                    {phase === 'visit' && online && (
                      <button className="link small danger-text" onClick={() => void deletePhoto(p.id)}>
                        șterge
                      </button>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        </>
      )}

      {/* ------------------------------------------------------------------ RAPORTEZ */}
      {tab === 'report' && (
        <>
          {phase === 'visit' && (
            <section className={`field-card ${missing.length ? 'todo' : 'ready'}`}>
              <h2>{missing.length ? 'Ce mai lipsește' : 'Raportul poate fi trimis'}</h2>
              {missing.length ? (
                <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                  {missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              ) : (
                <p className="small" style={{ margin: 0 }}>
                  Termen: 10 zile lucrătoare de la vizită. Raportul se generează în structura Anexei 6, cu fotografiile și semnătura în anexă.
                </p>
              )}
            </section>
          )}

          {shown('documents_checked') && (
            <section className="field-card">
              <h2>13. Documente verificate și metoda</h2>
              <RowsEditor
                name="Documente verificate"
                rows={rows('documents_checked')}
                editable={editable('documents_checked')}
                onChange={(r) => setList('documents_checked', r)}
                addLabel="Document"
                rowTitle={(r, i) => `${i + 1}. ${r.document ?? ''}`}
                columns={[
                  { key: 'document', label: 'Documentul' },
                  { key: 'method', label: 'Metoda', type: 'choice', options: opts('verification_method'), buttons: true },
                  { key: 'observation', label: 'Observații' },
                ]}
              />
            </section>
          )}

          <section className="field-card">
            <h2>Concluzii</h2>
            {textField('other_findings', { placeholder: 'Abateri de la contract și măsurile luate' })}
            {textField('risks', { placeholder: 'Riscuri pentru finalizarea la termen, pentru indicatori, pentru durabilitate' })}
            {textField('findings', { rows: 4, placeholder: 'Pe scurt: ce există, ce corespunde, ce nu corespunde' })}
            {choiceField('deviation_type', 'deviation_type', 'Întârzierea nu este, în sine, neregulă. Suspiciunile de neregulă sau fraudă se semnalează ierarhic.')}
            {choiceField('result', 'visit_result')}
            {choiceField('escalation_level', 'escalation_level', 'Primul indicator de etapă neîndeplinit nu atrage măsuri corective.')}
          </section>

          {shown('recommendations') && (
            <section className="field-card">
              <h2>12. Recomandări / plan de acțiune</h2>
              <p className="small muted" style={{ marginTop: 0 }}>
                O recomandare bună este concretă și măsurabilă, are termen și spune ce dovadă se încarcă în MySMIS. Ex.: „Montarea afișului A3 la intrare – 30 de zile – fotografie datată”.
              </p>
              <RowsEditor
                name="Recomandări"
                rows={rows('recommendations')}
                editable={editable('recommendations')}
                onChange={(r) => setList('recommendations', r)}
                addLabel="Recomandare"
                columns={[
                  { key: 'recommendation', label: 'Recomandarea', type: 'textarea' },
                  { key: 'deadline', label: 'Termen', type: 'date' },
                  { key: 'evidence_required', label: 'Dovada cerută', placeholder: 'ex. fotografie datată, PV, contract' },
                ]}
                empty={values.result === 'conform' ? 'Fără recomandări.' : 'Adăugați cel puțin o recomandare.'}
              />
            </section>
          )}

          <section className="field-card">
            <h2>Semnătura reprezentantului beneficiarului</h2>
            {(localSignature || serverSignature) && (
              <div className="row small" style={{ marginBottom: 8, alignItems: 'center' }}>
                {serverSignature && !localSignature && <img src={serverSignature.url} alt="Semnătura preluată" style={{ height: 60, border: '1px solid var(--c-border)', background: '#fff' }} />}
                <span>
                  {localSignature ? 'Semnătură salvată pe dispozitiv (se trimite la sincronizare).' : `Semnătura lui ${serverSignature.signer_name ?? 'reprezentantului'} este preluată.`} O semnătură nouă o înlocuiește.
                </span>
              </div>
            )}
            {phase === 'visit' ? (
              <>
                <label className="field">
                  <span className="label">Numele semnatarului</span>
                  <input className="field-input" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
                </label>
                <SignaturePad onChange={setSignature} />
                <button className="primary big" style={{ marginTop: 8 }} disabled={!signature || !signerName.trim()} onClick={() => void saveSignature()}>
                  Salvează semnătura
                </button>
              </>
            ) : (
              !serverSignature && <p className="small muted">Se preia pe teren, la încheierea vizitei.</p>
            )}
          </section>

          {phase === 'visit' && (
            <section className="field-card">
              <h2>Finalizare</h2>
              <p className="small muted">Raportul se generează din datele de mai sus, cu fotografiile și semnătura în anexă. Semnarea și trimiterea la avizare au nevoie de semnal.</p>
              <button className="primary big" disabled={!online || busy === 'finish'} onClick={() => void finish()}>
                {busy === 'finish' ? 'Se trimite…' : 'Semnează raportul și trimite la avizare'}
              </button>
              {!online && (
                <div className="small muted" style={{ marginTop: 6 }}>
                  Disponibil când revine semnalul.
                </div>
              )}
            </section>
          )}
        </>
      )}

      {tab === 'guide' && <FieldGuide />}

      <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void addPhotos(e.target.files)} />
      <input ref={galleryInput} type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files)} />
    </div>
  );
}

function useBlobUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

function PrevThumb({ blob, caption, onRetake }: { blob: Blob; caption: string | null; onRetake: () => void }) {
  const url = useBlobUrl(blob);
  return (
    <figure className="prev-thumb">
      {url && <img src={url} alt={caption ?? 'Fotografie din vizita anterioară'} />}
      <figcaption>
        {caption && <div>{caption}</div>}
        <button type="button" className="link small" onClick={onRetake}>
          📷 același unghi
        </button>
      </figcaption>
    </figure>
  );
}

function LocalThumb({ op, onRemove }: { op: Extract<QueuedOp, { kind: 'evidence' }>; onRemove: () => void }) {
  const url = useBlobUrl(op.blob);
  const gps = gpsLabel({ latitude: op.meta.latitude, longitude: op.meta.longitude, accuracy_m: op.meta.accuracy });
  return (
    <figure className="field-photo">
      {url && <img src={url} alt={op.meta.caption ?? 'Fotografie nesincronizată'} />}
      <figcaption>
        {op.meta.section && <div className="muted">{op.meta.section}</div>}
        {op.meta.caption && <strong>{op.meta.caption}</strong>}
        <div>{fmtDateTime(op.meta.takenAt)}</div>
        <div>{gps ? `GPS ${gps}` : 'fără GPS'}</div>
        <span className={`tag ${op.error ? 'err' : 'wait'}`}>{op.error ? 'refuzată' : 'pe dispozitiv'}</span>
        <button className="link small danger-text" onClick={onRemove}>
          renunță
        </button>
      </figcaption>
    </figure>
  );
}
