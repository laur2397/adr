import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError } from '../api';
import { CoiBanner } from '../components/Collaboration';
import { gpsLabel, mapLink, SignaturePad } from '../components/Evidence';
import { ErrorAlert, Loading } from '../components/ui';
import { fmtDate, fmtDateTime, todayIso } from '../format';
import { compressPhoto, enqueue, flush, loadSnapshot, newClientId, pending, removeOp, retryOp, saveSnapshot, type FieldSnapshot, type QueuedOp } from '../offline';

/**
 * On-site verification page for a phone or tablet. Works without signal: the dossier is kept on the
 * device, every change is queued and sent when the connection returns. Photos carry the device time
 * and GPS position; the beneficiary's representative signs on the screen.
 */

interface Fix {
  latitude: number;
  longitude: number;
  accuracy: number;
  at: number;
}

const VISIT_FIELDS = ['visit_date', 'representative', 'representative_role', 'findings', 'result', 'recommendations', 'recommendations_deadline'];

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

function useGps() {
  const [fix, setFix] = useState<Fix | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
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
  }, []);
  return { fix, error };
}

export function FieldVisit() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const gps = useGps();
  const [snap, setSnap] = useState<FieldSnapshot | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [queue, setQueue] = useState<QueuedOp[]>([]);
  const [values, setValues] = useState<Record<string, any>>({});
  const [answers, setAnswers] = useState<Record<string, { answer: string | null; observation: string }>>({});
  const [caption, setCaption] = useState('');
  const [signature, setSignature] = useState<Blob | null>(null);
  const [signerName, setSignerName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error' | 'info'; text: string; list?: string[] } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const fieldTimer = useRef<number | null>(null);
  const unsent = useRef<Record<string, unknown>>({});
  const [obsOpen, setObsOpen] = useState<Set<string>>(new Set());

  const reloadQueue = useCallback(async () => setQueue(await pending(id)), [id]);

  /** Loads the dossier from the server when online (and keeps a copy), otherwise from the device. */
  const load = useCallback(async () => {
    let s: FieldSnapshot | undefined;
    if (navigator.onLine) {
      try {
        const [dossier, evidence, results] = await Promise.all([api.get(`/instances/${id}`), api.get(`/instances/${id}/evidence`), api.get('/nomenclatures/visit_result')]);
        s = { dossier, evidence: evidence.items, results: results.items, savedAt: new Date().toISOString() };
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
    const base = Object.fromEntries(s.dossier.fields.map((f: any) => [f.key, f.value]));
    for (const op of q) if (op.kind === 'fields') Object.assign(base, op.fields);
    if (!base.visit_date) {
      base.visit_date = todayIso();
      // The date shown by default must also reach the server, or the report is refused for a missing date.
      const t = s.dossier.tasks.find((x: any) => x.canAct && x.evidence);
      if (t && s.dossier.fields.some((f: any) => f.key === 'visit_date' && ['editable', 'required'].includes(f.access))) {
        await enqueue({ instanceId: id, kind: 'fields', taskId: t.id, fields: { visit_date: base.visit_date }, createdAt: new Date().toISOString() });
        setQueue(await pending(id));
      }
    }
    setValues(base);
    const cl = s.dossier.checklists.find((c: any) => c.key === 'onsite');
    const a: Record<string, { answer: string | null; observation: string }> = {};
    for (const item of cl?.items ?? []) a[item.code] = { answer: item.responses.primary?.answer ?? null, observation: item.responses.primary?.observation ?? '' };
    for (const op of q) if (op.kind === 'checklist') for (const r of op.responses) a[r.code] = { answer: r.answer, observation: r.observation ?? '' };
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

  const task = useMemo(() => snap?.dossier.tasks.find((t: any) => t.canAct && t.evidence) ?? null, [snap]);
  const queued = useMemo(() => snap?.dossier.tasks.find((t: any) => t.evidence && !t.assignee) ?? null, [snap]);
  const checklist = snap?.dossier.checklists.find((c: any) => c.key === 'onsite');
  const fieldDefs = useMemo(() => Object.fromEntries((snap?.dossier.fields ?? []).map((f: any) => [f.key, f])), [snap]);

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
  const editable = (key: string) => Boolean(task) && ['editable', 'required'].includes(fieldDefs[key]?.access);
  const required = (key: string) => fieldDefs[key]?.access === 'required';
  const waiting = queue.filter((q) => !q.error);
  const refused = queue.filter((q) => q.error);

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

  const setAnswer = async (code: string, patch: Partial<{ answer: string | null; observation: string }>) => {
    const next = { ...answers, [code]: { ...answers[code]!, ...patch } };
    setAnswers(next);
    if (!task) return;
    await enqueue({
      instanceId: id,
      kind: 'checklist',
      taskId: task.id,
      checklistKey: 'onsite',
      responses: Object.entries(next)
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

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length || !task) return;
    setBusy('photo');
    setMessage(null);
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
            caption: caption.trim() || undefined,
            takenAt: new Date(file.lastModified && Date.now() - file.lastModified < 600_000 ? file.lastModified : Date.now()).toISOString(),
            ...(fix ? { latitude: Number(fix.latitude.toFixed(6)), longitude: Number(fix.longitude.toFixed(6)), accuracy: Math.round(fix.accuracy) } : {}),
          },
          createdAt: new Date().toISOString(),
        });
      }
      setCaption('');
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
    if (!signature || !task) return;
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

  const finish = async () => {
    if (!task) return;
    setBusy('finish');
    setMessage(null);
    try {
      await sync();
      if ((await pending(id)).length) throw new Error('Mai sunt modificări netrimise. Rezolvați-le înainte de a trimite raportul.');
      await api.post(`/instances/${id}/documents/visit_report/sign`);
      await api.post(`/instances/${id}/transitions`, { taskId: task.id, path: 'submit' });
      navigate(`/dosare/${id}`);
    } catch (err) {
      if (err instanceof ApiError) setMessage({ tone: 'error', text: err.title, list: err.errors.map((e) => e.message) });
      else setMessage({ tone: 'error', text: (err as Error).message });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const serverPhotos = snap.evidence.filter((e: any) => e.kind === 'photo');
  const serverSignature = snap.evidence.find((e: any) => e.kind === 'signature');
  const localPhotos = queue.filter((q): q is Extract<QueuedOp, { kind: 'evidence' }> => q.kind === 'evidence' && q.meta.kind === 'photo');
  const localSignature = queue.find((q): q is Extract<QueuedOp, { kind: 'evidence' }> => q.kind === 'evidence' && q.meta.kind === 'signature');
  const answered = Object.values(answers).filter((a) => a.answer).length;
  const total = checklist?.items.length ?? 0;
  const location = values.location as string | undefined;

  return (
    <div className="field-page">
      <header className="field-head">
        <Link to={`/dosare/${id}`} className="field-back" aria-label="Înapoi la dosar">
          ←
        </Link>
        <div className="field-title">
          <div className="small">Verificare la fața locului</div>
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

      {refused.length > 0 && (
        <div className="alert error small">
          <strong>Serverul a refuzat {refused.length === 1 ? 'o modificare' : `${refused.length} modificări`}:</strong>
          {refused.map((op) => (
            <div key={op.id} className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
              <span>
                {op.kind === 'evidence' ? (op.meta.kind === 'photo' ? 'Fotografie' : 'Semnătură') : op.kind === 'fields' ? 'Date' : 'Listă de verificare'}: {op.error}
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

      {task && d.status === 'active' && online && <CoiBanner instanceId={id} coi={d.coi} onDeclared={() => void load()} />}
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
          Dosarul nu este la pasul de vizită sau nu vă este repartizat; pagina este doar pentru consultare. <Link to={`/dosare/${id}`}>Deschide dosarul</Link>
        </div>
      )}

      <section className="field-card">
        <h2>Detalii</h2>
        <dl className="field-dl">
          <dt>Proiect</dt>
          <dd>{d.project?.title}</dd>
          <dt>Programată</dt>
          <dd>{values.planned_date ? fmtDate(values.planned_date) : '—'}</dd>
          <dt>Locul</dt>
          <dd>
            {location ?? '—'}
            {location && (
              <>
                {' '}
                ·{' '}
                <a href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(location)}`} target="_blank" rel="noreferrer">
                  hartă
                </a>
              </>
            )}
          </dd>
          <dt>Contact</dt>
          <dd>{values.beneficiary_contact ?? '—'}</dd>
          <dt>Verificat</dt>
          <dd>{values.sampled_reference ?? '—'}</dd>
        </dl>
        <div className={`gps ${gps.fix ? 'ok' : 'none'}`}>
          {gps.fix ? (
            <>
              Poziția dvs.: {gpsLabel({ latitude: gps.fix.latitude, longitude: gps.fix.longitude, accuracy_m: gps.fix.accuracy })}
            </>
          ) : (
            (gps.error ?? 'Se caută poziția GPS…')
          )}
        </div>
      </section>

      {checklist && (
        <section className="field-card">
          <h2>
            Lista de verificare <span className="muted small">{answered}/{total}</span>
          </h2>
          {checklist.items.map((item: any) => {
            const a = answers[item.code] ?? { answer: null, observation: '' };
            const needsObs = a.answer && item.observationRequiredOn.includes(a.answer);
            return (
              <div key={item.code} className="field-q">
                <div className="field-q-text">
                  <span className="muted">{item.code}.</span> {item.question}
                </div>
                <div className="field-answers" role="group" aria-label={`Răspuns la punctul ${item.code}`}>
                  {checklist.answerSet.map((opt: string) => (
                    <button key={opt} type="button" className={a.answer === opt ? `sel ${opt.toLowerCase()}` : ''} aria-pressed={a.answer === opt} disabled={!task} onClick={() => setAnswer(item.code, { answer: opt })}>
                      {opt === 'DA' ? 'Da' : opt === 'NU' ? 'Nu' : 'N/A'}
                    </button>
                  ))}
                </div>
                {(needsObs || a.observation || obsOpen.has(item.code)) && (
                  <textarea
                    aria-label={`Observație la punctul ${item.code}`}
                    placeholder={needsObs ? 'Observație obligatorie' : 'Observație'}
                    value={a.observation}
                    disabled={!task}
                    onChange={(e) => setAnswers((x) => ({ ...x, [item.code]: { ...a, observation: e.target.value } }))}
                    onBlur={(e) => setAnswer(item.code, { observation: e.target.value })}
                    className={needsObs && !a.observation ? 'invalid' : ''}
                  />
                )}
                {!needsObs && !a.observation && !obsOpen.has(item.code) && a.answer && task && (
                  <button type="button" className="link small" onClick={() => setObsOpen((o) => new Set(o).add(item.code))}>
                    + observație
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}

      <section className="field-card">
        <h2>
          Fotografii <span className="muted small">{serverPhotos.length + localPhotos.length}</span>
        </h2>
        {task && (
          <>
            <input className="field-input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Descriere (opțional), ex. Utilaj CNC, seria 4471" aria-label="Descrierea fotografiei" />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="primary big" onClick={() => photoInput.current?.click()} disabled={busy === 'photo'}>
                {busy === 'photo' ? 'Se salvează…' : 'Fă o fotografie'}
              </button>
              <button className="big" onClick={() => galleryInput.current?.click()} disabled={busy === 'photo'}>
                Din galerie
              </button>
            </div>
            <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void addPhotos(e.target.files)} />
            <input ref={galleryInput} type="file" accept="image/*" multiple hidden onChange={(e) => void addPhotos(e.target.files)} />
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
                {task && online && (
                  <button className="link small danger-text" onClick={() => void deletePhoto(p.id)}>
                    șterge
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="field-card">
        <h2>Constatări</h2>
        {VISIT_FIELDS.filter((k) => fieldDefs[k]).map((key) => {
          const f = fieldDefs[key];
          const label = `${f.label}${required(key) ? ' *' : ''}`;
          if (key === 'result') {
            return (
              <label key={key} className="field">
                <span className="label">{label}</span>
                <select className="field-input" value={values[key] ?? ''} disabled={!editable(key)} onChange={(e) => setField(key, e.target.value || null)}>
                  <option value="">— alegeți —</option>
                  {snap.results.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          return (
            <label key={key} className="field">
              <span className="label">{label}</span>
              {f.type === 'textarea' ? (
                <textarea className="field-input" rows={4} value={values[key] ?? ''} disabled={!editable(key)} onChange={(e) => setField(key, e.target.value)} />
              ) : (
                <input
                  className="field-input"
                  type={f.type === 'date' ? 'date' : 'text'}
                  value={values[key] ?? ''}
                  disabled={!editable(key)}
                  onChange={(e) => {
                    setField(key, e.target.value || null);
                    if (key === 'representative' && !signerName) setSignerName(e.target.value);
                  }}
                />
              )}
            </label>
          );
        })}
      </section>

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
        {task && (
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
        )}
      </section>

      {task && (
        <section className="field-card">
          <h2>Finalizare</h2>
          <p className="small muted">
            Raportul se generează din datele de mai sus, cu fotografiile și semnătura în anexă. Semnarea și trimiterea la avizare au nevoie de semnal.
          </p>
          <button className="primary big" disabled={!online || busy === 'finish'} onClick={() => void finish()}>
            {busy === 'finish' ? 'Se trimite…' : 'Semnează raportul și trimite la avizare'}
          </button>
          {!online && <div className="small muted" style={{ marginTop: 6 }}>Disponibil când revine semnalul.</div>}
        </section>
      )}
    </div>
  );
}

function LocalThumb({ op, onRemove }: { op: Extract<QueuedOp, { kind: 'evidence' }>; onRemove: () => void }) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    const u = URL.createObjectURL(op.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [op.blob]);
  const gps = gpsLabel({ latitude: op.meta.latitude, longitude: op.meta.longitude, accuracy_m: op.meta.accuracy });
  return (
    <figure className="field-photo">
      {url && <img src={url} alt={op.meta.caption ?? 'Fotografie nesincronizată'} />}
      <figcaption>
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
