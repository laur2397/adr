import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, can } from '../api';
import { FieldInput, type FieldView } from '../components/fields';
import { AuditPanel, ChecklistPanel, DeadlinesPanel, DocumentsPanel, HistoryPanel, RegistrationsPanel } from '../components/InstancePanels';
import { CoiBanner, CommentsPanel, DoubleFundingAlerts } from '../components/Collaboration';
import { EvidencePanel } from '../components/Evidence';
import { ProcessDiagram } from '../components/ProcessDiagram';
import { LineItems } from '../components/LineItems';
import { Badge, Card, ErrorAlert, Loading, Modal, StatusBadge, useMe } from '../components/ui';
import { fmtAmount, fmtDate, fmtDateTime } from '../format';

type Tab = 'form' | 'checklist' | 'visit' | 'documents' | 'comments' | 'flow' | 'deadlines' | 'history' | 'registers' | 'audit';

function Circuit({ steps }: { steps: any[] }) {
  const ref = useRef<HTMLOListElement>(null);
  // On a narrow screen the bar scrolls sideways: bring the current step into view.
  useEffect(() => {
    const ol = ref.current;
    const cur = ol?.querySelector('[aria-current="step"]');
    if (!ol || !cur || ol.scrollWidth <= ol.clientWidth) return;
    ol.scrollLeft += cur.getBoundingClientRect().left - ol.getBoundingClientRect().left - 24;
  }, [steps]);
  return (
    <ol className="circuit" aria-label="Circuitul dosarului" ref={ref}>
      {steps.map((s) => (
        <li key={s.key}>
          <span className={`step ${s.state}`} aria-current={s.state === 'current' ? 'step' : undefined}>
            {s.name}
            {s.state === 'done' && s.lastActor && (
              <span className="who">
                {s.lastActor}, {fmtDate(s.lastAt?.slice(0, 10))}
              </span>
            )}
            {s.state === 'current' && <span className="sr-only"> (pasul curent)</span>}
            {s.state === 'skipped' && <span className="who">nu a fost cazul</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Documents the current step's actions need signed, with Open and Sign at hand (no tab switching on a phone). */
function SignHere({ instance, keys }: { instance: any; keys: string[] }) {
  const me = useMe();
  const qc = useQueryClient();
  const sign = useMutation({
    mutationFn: (key: string) => api.post(`/instances/${instance.id}/documents/${key}/sign`),
    onSuccess: (r: any) => {
      if (r?.redirectUrl) window.open(r.redirectUrl, '_blank', 'noopener');
      qc.invalidateQueries({ queryKey: ['instance', instance.id] });
      qc.invalidateQueries({ queryKey: ['signatures-pending'] });
    },
  });
  if (!keys.length) return null;
  return (
    <>
      <ErrorAlert error={sign.error} />
      <ul className="sign-list" aria-label="Documente de semnat la acest pas">
        {keys.map((key) => {
          const doc = instance.documents.find((d: any) => d.key === key);
          const latest = doc?.versions[0];
          const signed = doc?.signatures.some((x: any) => x.status === 'signed' && x.signer_user_id === me.id);
          return (
            <li key={key}>
              <div className="doc">
                <strong>{doc?.title ?? instance.documentTitles?.[key] ?? key}</strong>
                <span className="small muted">{latest ? `v${latest.version_no} · ${fmtDateTime(latest.created_at)}` : 'se generează la semnare'}</span>
              </div>
              <div className="row">
                {latest && (
                  <a className="button small" href={`/api/v1/documents/versions/${latest.id}/content?inline=1`} target="_blank" rel="noopener">
                    Deschide
                  </a>
                )}
                {signed ? (
                  <Badge tone="green">Semnat de dvs.</Badge>
                ) : (
                  <button className="primary small" disabled={sign.isPending} onClick={() => sign.mutate(key)}>
                    {sign.isPending && sign.variables === key ? 'Se semnează…' : latest ? 'Semnează' : 'Generează și semnează'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ActionPanel({ instance, task }: { instance: any; task: any }) {
  const qc = useQueryClient();
  const toSign: string[] = [...new Set<string>(task.paths.flatMap((p: any) => p.requiresSignatures))];
  const [path, setPath] = useState<any | null>(null);
  const [comment, setComment] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const needsAssignee = Boolean(path) && path.chooseAssignee !== null && path.chooseAssignee !== undefined;
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users'), enabled: needsAssignee });
  const go = useMutation({
    mutationFn: () => api.post(`/instances/${instance.id}/transitions`, { taskId: task.id, path: path.key, comment: comment || undefined, assignTo: assignTo || undefined }),
    onSuccess: () => {
      setPath(null);
      setComment('');
      setAssignTo('');
      qc.invalidateQueries();
    },
  });
  const close = () => {
    setPath(null);
    go.reset();
  };
  const candidates = (users.data?.items ?? []).filter((u: any) => !path?.chooseAssignee || u.roles.includes(path.chooseAssignee));

  return (
    <Card title={`Sarcina mea: ${task.name}`}>
      {task.onBehalfOf && <div className="alert info small">Acționați în numele unui coleg absent; acțiunile se înregistrează astfel.</div>}
      {task.dueAt && <p className="small muted">Termen intern: {fmtDate(task.dueAt.slice(0, 10))}</p>}
      <SignHere instance={instance} keys={toSign} />
      <div className="row actions-bar">
        {task.paths.map((p: any) => (
          <button key={p.key} className={p.kind === 'forward' ? 'primary' : p.kind === 'reject' ? 'danger' : ''} onClick={() => setPath(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <Modal
        open={Boolean(path)}
        title={path?.label ?? ''}
        onClose={close}
        footer={
          <>
            <button onClick={close}>Renunță</button>
            <button className={path?.kind === 'reject' ? 'danger' : 'primary'} disabled={go.isPending} onClick={() => go.mutate()}>
              {go.isPending ? 'Se trimite…' : 'Confirm'}
            </button>
          </>
        }
      >
        <ErrorAlert error={go.error} />
        <p>
          {path?.kind === 'return'
            ? 'Dosarul se întoarce la un pas anterior. Semnăturile date de atunci încoace vor fi invalidate.'
            : path?.kind === 'reject'
              ? 'Dosarul va fi închis. Acțiunea nu poate fi anulată.'
              : 'Confirmați finalizarea pasului? Dosarul trece la pasul următor.'}
        </p>
        {needsAssignee && (
          <label className="field">
            <span className="label">
              Repartizează către<span className="req">*</span>
            </span>
            <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} required>
              <option value="">— alegeți —</option>
              {candidates.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} {u.department ? `(${u.department})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="label">
            Comentariu{path?.requiresComment && <span className="req">*</span>}
          </span>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} required={path?.requiresComment} />
          {path?.requiresComment && <span className="field-hint">Obligatoriu pentru această acțiune (motivul).</span>}
        </label>
      </Modal>
    </Card>
  );
}

function FormPanel({ instance, task }: { instance: any; task: any | null }) {
  const qc = useQueryClient();
  const fields: FieldView[] = instance.fields;
  const simple = fields.filter((f) => f.type !== 'line_items');
  const lists = fields.filter((f) => f.type === 'line_items');
  const initial = () => Object.fromEntries(simple.map((f) => [f.key, f.type === 'amount' && f.value ? fmtAmount(f.value) : f.value]));
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (dirty.size === 0) setValues(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance]);
  const save = useMutation({
    mutationFn: () => api.patch(`/instances/${instance.id}/fields`, { taskId: task.id, fields: Object.fromEntries([...dirty].map((k) => [k, values[k]])) }),
    onSuccess: () => {
      setDirty(new Set());
      qc.invalidateQueries({ queryKey: ['instance', instance.id] });
    },
  });
  const saveList = useMutation({
    mutationFn: ({ key, rows }: { key: string; rows: unknown[] }) => api.put(`/instances/${instance.id}/lists/${key}`, { taskId: task.id, rows }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instance', instance.id] }),
  });
  const errors = [
    ...((save.error as ApiError | null)?.errors ?? []),
    ...((saveList.error as ApiError | null)?.errors ?? []),
  ];
  const editable = Boolean(task) && instance.permission === 'edit';
  const anyEditable = editable && simple.some((f) => f.access !== 'visible');

  return (
    <Card
      title="Date dosar"
      actions={
        anyEditable && (
          <button className="primary small" disabled={dirty.size === 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Se salvează…' : 'Salvează'}
          </button>
        )
      }
    >
      {save.error instanceof ApiError && <ErrorAlert error={new ApiError(save.error.status, save.error.title)} />}
      {save.isSuccess && dirty.size === 0 && <div className="alert success small" role="status">Datele au fost salvate.</div>}
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty.size) save.mutate();
        }}
      >
        {simple.map((f) => (
          <FieldInput
            key={f.key}
            field={{ ...f, access: editable ? f.access : 'visible' }}
            value={values[f.key]}
            projectId={instance.project?.id}
            error={errors.find((e) => e.field === f.key)}
            onChange={(v) => {
              setValues((x) => ({ ...x, [f.key]: v }));
              setDirty((d) => new Set(d).add(f.key));
            }}
          />
        ))}
        {lists.map((f) => (
          <LineItems
            key={f.key}
            field={f}
            editable={editable && f.access !== 'visible'}
            projectId={instance.project?.id ?? null}
            saving={saveList.isPending}
            errors={errors}
            onSave={(rows) => saveList.mutate({ key: f.key, rows })}
          />
        ))}
        {saveList.error instanceof ApiError && (
          <div className="wide">
            <ErrorAlert error={saveList.error} />
          </div>
        )}
      </form>
    </Card>
  );
}

export function InstancePage() {
  const { id } = useParams();
  const me = useMe();
  const q = useQuery({ queryKey: ['instance', id], queryFn: () => api.get(`/instances/${id}`) });
  const [tab, setTab] = useState<Tab>(() => (window.location.hash === '#documente' ? 'documents' : 'form'));
  const instance = q.data;
  const task = useMemo(() => instance?.tasks.find((t: any) => t.canAct) ?? null, [instance]);
  const signable: string[] = useMemo(() => [...new Set<string>((task?.paths ?? []).flatMap((p: any) => p.requiresSignatures))], [task]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const tabs: Array<[Tab, string, boolean]> = [
    ['form', 'Formular', true],
    ['checklist', 'Listă de verificare', instance.checklists.length > 0],
    ['visit', 'Fotografii și semnătură', instance.definition.key === 'p8_onsite_verification'],
    ['documents', `Documente (${instance.documents.length})`, true],
    ['comments', 'Comentarii', true],
    ['flow', 'Flux', true],
    ['deadlines', 'Termene', true],
    ['history', 'Istoric', true],
    ['registers', 'Înregistrări', true],
    ['audit', 'Jurnal de audit', can.audit(me)],
  ];
  const others = instance.tasks.filter((t: any) => !t.canAct);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="muted small">
            <Link to="/dosare">Dosare</Link> / {instance.definition.name} (v{instance.definition.version})
          </div>
          <h1>{instance.title}</h1>
          <div className="row">
            <StatusBadge status={instance.status} />
            {instance.referenceNo && <span>Nr. înregistrare {instance.referenceNo}</span>}
            <span className="muted small">pornit {fmtDateTime(instance.startedAt)}</span>
          </div>
        </div>
        <div className="small" style={{ textAlign: 'right' }}>
          {instance.beneficiary && (
            <div>
              <strong>{instance.beneficiary.name}</strong> · CUI {instance.beneficiary.cui}
            </div>
          )}
          {instance.project && (
            <div className="muted">
              SMIS {instance.project.smis_code} · contract {instance.project.contract_number}
            </div>
          )}
        </div>
      </div>
      <Card flush>
        <Circuit steps={instance.steps} />
      </Card>
      {(instance.parentInstanceId || instance.children?.length > 0) && (
        <div className="alert info small">
          {instance.parentInstanceId && (
            <div>
              Dosar deschis din <Link to={`/dosare/${instance.parentInstanceId}`}>dosarul părinte</Link>.
            </div>
          )}
          {instance.children?.map((c: any) => (
            <div key={c.id}>
              Dosar legat: <Link to={`/dosare/${c.id}`}>{c.title}</Link> ({c.definition_name}
              {c.reference_no ? `, nr. ${c.reference_no}` : ''}) – <StatusBadge status={c.status} />
            </div>
          ))}
        </div>
      )}
      <DoubleFundingAlerts items={instance.doubleFunding} />
      {task && instance.status === 'active' && <CoiBanner instanceId={instance.id} coi={instance.coi} />}
      {task && instance.status === 'active' && <ActionPanel instance={instance} task={task} />}
      {task?.evidence && instance.status === 'active' && (
        <div className="alert info row" style={{ justifyContent: 'space-between' }}>
          <span>La beneficiar folosiți modul de teren: listă de verificare, fotografii cu GPS și semnătura reprezentantului, chiar și fără semnal.</span>
          <Link className="button primary small" to={`/teren/${instance.id}`}>
            Deschide modul de teren
          </Link>
        </div>
      )}
      {!task && instance.status === 'active' && others.length > 0 && (
        <div className="alert info">
          Dosarul este la: {others.map((t: any) => `${t.name} (${t.assignee ?? `coada ${t.queue}`})`).join('; ')}.
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Secțiuni dosar">
        {tabs
          .filter(([, , show]) => show)
          .map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} id={`tab-${key}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'form' && <FormPanel instance={instance} task={task} />}
        {tab === 'checklist' && (
          <div className="stack">
            {instance.checklists.map((c: any) => (
              <ChecklistPanel key={c.key} instanceId={instance.id} checklist={c} task={task} />
            ))}
          </div>
        )}
        {tab === 'visit' && <EvidencePanel instanceId={instance.id} fieldLink={Boolean(task?.evidence)} />}
        {tab === 'documents' && <DocumentsPanel instance={instance} signable={signable} canEdit={Boolean(task)} />}
        {tab === 'comments' && <CommentsPanel instanceId={instance.id} />}
        {tab === 'flow' && (
          <Card title={`Fluxul procesului: ${instance.definition.name} (v${instance.definition.version})`}>
            <p className="small muted">Verde: pași parcurși · plin: pasul curent · linie întreruptă portocalie: returnări posibile.</p>
            <ProcessDiagram steps={instance.flow} states={Object.fromEntries(instance.steps.map((s: any) => [s.key, s.state]))} />
          </Card>
        )}
        {tab === 'deadlines' && <DeadlinesPanel deadlines={instance.deadlines} />}
        {tab === 'history' && <HistoryPanel history={instance.history} />}
        {tab === 'registers' && <RegistrationsPanel registrations={instance.registrations} />}
        {tab === 'audit' && <AuditPanel instanceId={instance.id} />}
      </div>
    </div>
  );
}
