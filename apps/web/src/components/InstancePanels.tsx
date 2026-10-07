import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { fmtDate, fmtDateTime } from '../format';
import { Badge, Card, Empty, ErrorAlert, Loading, useMe } from './ui';

const ANSWER_LABEL: Record<string, string> = { DA: 'Da', NU: 'Nu', NA: 'N/A', DA_CU_OBS: 'Da, cu observații' };
const VERIFIER_LABEL: Record<string, string> = { primary: 'Verificare (EVF)', second: 'A doua verificare (EI)' };

export function ChecklistPanel({ instanceId, checklist, task }: { instanceId: string; checklist: any; task: any | null }) {
  const qc = useQueryClient();
  const verifier: string | null = task?.checklist === checklist.key ? (task.checklistVerifier ?? 'primary') : null;
  const initial = () =>
    Object.fromEntries(checklist.items.map((i: any) => [i.code, { answer: i.responses[verifier ?? 'primary']?.answer ?? null, observation: i.responses[verifier ?? 'primary']?.observation ?? '' }]));
  const [answers, setAnswers] = useState<Record<string, { answer: string | null; observation: string }>>(initial);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setAnswers(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklist]);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/instances/${instanceId}/checklists/${checklist.key}/responses`, {
        taskId: task.id,
        responses: Object.entries(answers).map(([code, a]) => ({ code, answer: a.answer, observation: a.observation || null })),
      }),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ['instance', instanceId] });
    },
  });
  const set = (code: string, patch: Partial<{ answer: string | null; observation: string }>) => {
    setDirty(true);
    setAnswers((a) => ({ ...a, [code]: { ...a[code]!, ...patch } }));
  };
  const answered = Object.values(answers).filter((a) => a.answer).length;
  const otherRoles = ['primary', 'second'].filter((r) => r !== verifier && checklist.items.some((i: any) => i.responses[r]));

  return (
    <Card
      title={`${checklist.name} (v${checklist.version})`}
      actions={
        verifier && (
          <>
            <span className="muted small">
              {answered}/{checklist.items.length} completate
            </span>
            <button className="primary small" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Se salvează…' : 'Salvează lista'}
            </button>
          </>
        )
      }
      flush
    >
      <ErrorAlert error={save.error} />
      {verifier && <p className="small muted" style={{ padding: '0.75rem 1rem 0' }}>Completați ca: {VERIFIER_LABEL[verifier]}.</p>}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Nr.</th>
              <th>Verificare</th>
              <th>Răspuns</th>
              <th>Observații</th>
              {otherRoles.map((r) => (
                <th key={r}>{VERIFIER_LABEL[r]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {checklist.items.map((item: any) => {
              const a = answers[item.code]!;
              const needsObs = a.answer && item.observationRequiredOn.includes(a.answer);
              const ro = item.responses[verifier ?? 'primary'];
              return (
                <tr key={item.code}>
                  <td>{item.code}</td>
                  <td>
                    {item.question}
                    {item.legalBasis && <div className="muted small">Temei: {item.legalBasis}</div>}
                  </td>
                  <td>
                    {verifier ? (
                      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
                        <legend className="sr-only">Răspuns la punctul {item.code}</legend>
                        {checklist.answerSet.map((opt: string) => (
                          <label key={opt} className="row small nowrap" style={{ gap: 4 }}>
                            <input type="radio" name={`q-${item.code}`} checked={a.answer === opt} onChange={() => set(item.code, { answer: opt })} />
                            {ANSWER_LABEL[opt] ?? opt}
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      (ANSWER_LABEL[ro?.answer] ?? '—')
                    )}
                  </td>
                  <td style={{ minWidth: 200 }}>
                    {verifier ? (
                      <>
                        <textarea
                          aria-label={`Observații la punctul ${item.code}`}
                          aria-invalid={needsObs && !a.observation ? true : undefined}
                          style={{ minHeight: 48 }}
                          value={a.observation}
                          onChange={(e) => set(item.code, { observation: e.target.value })}
                        />
                        {needsObs && !a.observation && <div className="field-error">Observațiile sunt obligatorii pentru acest răspuns.</div>}
                      </>
                    ) : (
                      (ro?.observation ?? '')
                    )}
                  </td>
                  {otherRoles.map((r) => (
                    <td key={r} className="small">
                      {ANSWER_LABEL[item.responses[r]?.answer] ?? '—'}
                      {item.responses[r]?.observation && <div className="muted">{item.responses[r].observation}</div>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const SIG_TONE: Record<string, 'green' | 'yellow' | 'gray' | 'red' | 'blue'> = { signed: 'green', pending: 'yellow', invalidated: 'gray', rejected: 'red', external: 'blue' };
const SIG_LABEL: Record<string, string> = { signed: 'semnat', pending: 'în curs', invalidated: 'invalidată', rejected: 'refuzată', external: 'semnătură existentă' };

export function DocumentsPanel({ instance, signable, canEdit }: { instance: any; signable: string[]; canEdit: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['instance', instance.id] });
    qc.invalidateQueries({ queryKey: ['signatures-pending'] });
  };
  const generate = useMutation({ mutationFn: (key: string) => api.post(`/instances/${instance.id}/documents/${key}/generate`), onSuccess: refresh });
  const sign = useMutation({
    mutationFn: (key: string) => api.post(`/instances/${instance.id}/documents/${key}/sign`),
    onSuccess: (r: any) => {
      if (r.redirectUrl) window.open(r.redirectUrl, '_blank', 'noopener');
      refresh();
    },
  });
  const upload = useMutation({
    mutationFn: (fd: FormData) => api.post(`/instances/${instance.id}/documents`, fd),
    onSuccess: refresh,
  });
  const onUpload = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    upload.mutate(fd);
    e.currentTarget.reset();
  };
  const isActive = instance.status === 'active';
  // Documents defined by the process that do not exist yet can be generated too.
  const missing = signable.filter((k) => !instance.documents.some((d: any) => d.key === k));

  return (
    <div className="stack" id="documente">
      <ErrorAlert error={generate.error ?? sign.error ?? upload.error} />
      {sign.isSuccess && <div className="alert success" role="status">Documentul a fost semnat.</div>}
      {instance.documents.length === 0 && missing.length === 0 && <Empty>Dosarul nu are documente încă.</Empty>}
      {missing.map((key) => (
        <Card key={key} title={instance.documentTitles?.[key] ?? key} actions={<button className="primary small" disabled={sign.isPending} onClick={() => sign.mutate(key)}>Generează și semnează</button>}>
          <p className="muted">Documentul va fi generat din șablon cu datele curente ale dosarului.</p>
        </Card>
      ))}
      {instance.documents.map((d: any) => {
        const latest = d.versions[0];
        const valid = d.signatures.filter((s: any) => s.status === 'signed' || s.status === 'external');
        const signedByMe = d.signatures.some((s: any) => s.status === 'signed' && s.signer_user_id === me.id);
        return (
          <Card
            key={d.id}
            title={
              <div>
                <h3 style={{ margin: 0 }}>{d.title}</h3>
                <span className="muted small">
                  v{latest?.version_no} · {latest?.file_name} · {fmtDateTime(latest?.created_at)}
                  {d.signatureLevel === 'qualified' && ' · necesită semnătură calificată'}
                </span>
              </div>
            }
            actions={
              <>
                {latest && (
                  <a className="button small" href={`/api/v1/documents/versions/${latest.id}/content?inline=1`} target="_blank" rel="noopener">
                    Deschide
                  </a>
                )}
                {latest?.mime_type === 'application/pdf' && d.key && (
                  <a className="button small" href={`/api/v1/documents/versions/${latest.id}/content?format=docx`}>
                    DOCX
                  </a>
                )}
                {isActive && canEdit && d.key && (
                  <button className="small" disabled={generate.isPending} onClick={() => generate.mutate(d.key)}>
                    {generate.isPending && generate.variables === d.key ? 'Se generează…' : 'Regenerează'}
                  </button>
                )}
                {isActive && signable.includes(d.key) && signedByMe && <Badge tone="green">Semnat de dumneavoastră</Badge>}
                {isActive && signable.includes(d.key) && !signedByMe && (
                  <button className="primary small" disabled={sign.isPending} onClick={() => sign.mutate(d.key)}>
                    {sign.isPending && sign.variables === d.key ? 'Se semnează…' : 'Semnează'}
                  </button>
                )}
              </>
            }
          >
            {d.signatures.length > 0 ? (
              <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {d.signatures.map((s: any) => (
                  <li key={s.id}>
                    <Badge tone={SIG_TONE[s.status]}>{SIG_LABEL[s.status] ?? s.status}</Badge> {s.signer_name ?? 'semnatar extern'}
                    {s.signer_role ? `, ${s.signer_role}` : ''} {s.signed_at && `· ${fmtDateTime(s.signed_at)}`} · nivel {s.level}
                    {s.validation_result?.simulated && <Badge tone="yellow">SIMULARE</Badge>}
                    {s.validation_result?.result && !s.validation_result.simulated && <span className="muted"> · validare: {s.validation_result.result}</span>}
                    {s.invalidated_reason && <div className="muted">{s.invalidated_reason}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted small">Nesemnat.</span>
            )}
            {valid.length > 0 && latest && <div className="muted small mono" style={{ marginTop: 6 }}>SHA-256: {latest.sha256}</div>}
            {d.versions.length > 1 && (
              <details style={{ marginTop: 8 }}>
                <summary className="small">Versiuni anterioare ({d.versions.length - 1})</summary>
                <ul className="small">
                  {d.versions.slice(1).map((v: any) => (
                    <li key={v.id}>
                      <a href={`/api/v1/documents/versions/${v.id}/content`}>v{v.version_no}</a> · {v.source} · {v.created_by_name} · {fmtDateTime(v.created_at)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        );
      })}
      {isActive && canEdit && (
        <Card title="Încarcă un document justificativ">
          <form onSubmit={onUpload} className="form-grid">
            <label className="field">
              <span className="label">Fișier (PDF, Word, Excel, imagine, XML)</span>
              <input type="file" name="file" required />
            </label>
            <label className="field">
              <span className="label">Titlu</span>
              <input name="title" placeholder="ex. Extras de cont martie 2026" />
            </label>
            <input type="hidden" name="docType" value="supporting" />
            <div className="wide">
              <button type="submit" disabled={upload.isPending}>
                {upload.isPending ? 'Se încarcă…' : 'Încarcă'}
              </button>
            </div>
          </form>
          {upload.data?.signatureValidation && (
            <div className="alert info small">PDF semnat detectat; rezultat validare: {upload.data.signatureValidation.result} — {upload.data.signatureValidation.message ?? ''}</div>
          )}
        </Card>
      )}
    </div>
  );
}

const DL_STATUS: Record<string, string> = { running: 'în curs', paused: 'suspendat', met: 'respectat', breached: 'depășit' };

export function DeadlinesPanel({ deadlines }: { deadlines: any[] }) {
  if (!deadlines.length) return <Empty>Nu există termene pentru acest dosar.</Empty>;
  return (
    <Card flush>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Termen</th>
              <th>Regulă</th>
              <th>Început</th>
              <th>Scadență</th>
              <th>Stare</th>
              <th>Suspendări</th>
            </tr>
          </thead>
          <tbody>
            {deadlines.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.name}
                  {d.legalStatus === 'to_validate' && (
                    <div>
                      <Badge tone="yellow">de validat juridic</Badge>
                    </div>
                  )}
                  {d.legalReference && <div className="muted small">{d.legalReference}</div>}
                </td>
                <td>{d.rule}</td>
                <td>{fmtDate(d.startedOn)}</td>
                <td className="nowrap">
                  {d.traffic && <span className={`dot ${d.traffic}`} aria-hidden="true" />}
                  {d.dueOn ? fmtDate(d.dueOn) : <span className="muted">se reia după suspendare</span>}
                </td>
                <td>
                  <Badge tone={d.status === 'breached' ? 'red' : d.status === 'met' ? 'green' : d.status === 'paused' ? 'yellow' : 'blue'}>{DL_STATUS[d.status] ?? d.status}</Badge>
                </td>
                <td>
                  {d.pauseCount}
                  {d.maxPauses ? ` din ${d.maxPauses}` : ''} {d.pausedDays ? <span className="muted small">({d.pausedDays} zile)</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function HistoryPanel({ history }: { history: any[] }) {
  return (
    <Card flush>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Pas</th>
              <th>Intrat</th>
              <th>Ieșit</th>
              <th>Cine</th>
              <th>Acțiune</th>
              <th>Comentariu</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h, i) => (
              <tr key={i}>
                <td>{h.stepName}</td>
                <td className="nowrap">{fmtDateTime(h.enteredAt)}</td>
                <td className="nowrap">{fmtDateTime(h.leftAt)}</td>
                <td>
                  {h.actor ?? (h.leftAt ? 'sistem' : '')}
                  {h.onBehalfOf && <div className="muted small">în numele: {h.onBehalfOf}</div>}
                </td>
                <td>{h.pathLabel ?? ''}</td>
                <td>{h.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const DIR: Record<string, string> = { in: 'Intrare', out: 'Ieșire', internal: 'Intern' };
export function RegistrationsPanel({ registrations }: { registrations: any[] }) {
  if (!registrations.length) return <Empty>Dosarul nu a fost înregistrat încă.</Empty>;
  return (
    <Card flush>
      <table className="data">
        <thead>
          <tr>
            <th>Registru</th>
            <th>Număr</th>
            <th>Tip</th>
            <th>Conținut</th>
          </tr>
        </thead>
        <tbody>
          {registrations.map((r) => (
            <tr key={r.id}>
              <td>{r.register_name}</td>
              <td className="nowrap">{r.number_display}</td>
              <td>{DIR[r.direction]}</td>
              <td>{r.subject}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function AuditPanel({ instanceId }: { instanceId: string }) {
  const q = useQuery({ queryKey: ['instance-audit', instanceId], queryFn: () => api.get(`/instances/${instanceId}/audit`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  return (
    <Card flush>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Moment</th>
              <th>Cine</th>
              <th>Acțiune</th>
              <th>Detalii</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((e: any) => (
              <tr key={e.id}>
                <td className="mono">{e.id}</td>
                <td className="nowrap">{fmtDateTime(e.occurred_at)}</td>
                <td>
                  {e.actor ?? 'sistem'}
                  {e.on_behalf_of && <div className="muted small">în numele: {e.on_behalf_of}</div>}
                  {e.ip && <div className="muted small">{e.ip}</div>}
                </td>
                <td className="mono">{e.action}</td>
                <td className="small mono" style={{ maxWidth: 420, wordBreak: 'break-word' }}>
                  {e.new_value ? JSON.stringify(e.new_value).slice(0, 300) : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
