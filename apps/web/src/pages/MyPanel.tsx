import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import { Card, DueBadge, Empty, ErrorAlert, Loading, useMe } from '../components/ui';
import { fmtDateTime, todayIso } from '../format';

interface Task {
  id: string;
  name: string;
  instance_id: string;
  instance_title: string;
  reference_no: string | null;
  process_name: string;
  beneficiary_name: string | null;
  due_at: string | null;
  instance_due: string | null;
  created_at: string;
  inQueue: boolean;
  queue_name: string | null;
  onBehalfOf: string | null;
}

function group(tasks: Task[], today: string) {
  const week = new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10);
  const groups: Record<string, Task[]> = { 'Termen depășit': [], Azi: [], 'Săptămâna aceasta': [], 'Mai târziu / fără termen': [] };
  for (const t of tasks) {
    const due = (t.due_at ?? t.instance_due)?.slice(0, 10);
    if (due && due < today) groups['Termen depășit']!.push(t);
    else if (due === today) groups.Azi!.push(t);
    else if (due && due <= week) groups['Săptămâna aceasta']!.push(t);
    else groups['Mai târziu / fără termen']!.push(t);
  }
  return groups;
}

function TaskTable({ tasks, today, claim }: { tasks: Task[]; today: string; claim?: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Dosar</th>
            <th>Pas</th>
            <th>Beneficiar</th>
            <th>Termen</th>
            {claim && <th><span className="sr-only">Acțiuni</span></th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <Link to={`/dosare/${t.instance_id}`}>{t.instance_title}</Link>
                <div className="muted small">
                  {t.reference_no ? `Nr. ${t.reference_no} · ` : ''}
                  {t.process_name}
                </div>
              </td>
              <td>
                {t.name}
                {t.onBehalfOf && <div className="small muted">în locul unui coleg absent</div>}
                {t.inQueue && <div className="small muted">coada: {t.queue_name}</div>}
              </td>
              <td>{t.beneficiary_name ?? '—'}</td>
              <td>
                <DueBadge due={t.due_at ?? t.instance_due} today={today} />
              </td>
              {claim && (
                <td className="right">
                  <button className="small" onClick={() => claim(t.id)}>
                    Preia
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MyPanel() {
  const me = useMe();
  const qc = useQueryClient();
  const today = todayIso();
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api.get<{ items: Task[] }>('/tasks'), refetchInterval: 60_000 });
  const toSign = useQuery({ queryKey: ['signatures-pending'], queryFn: () => api.get('/signatures/pending') });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications') });
  const claim = useMutation({
    mutationFn: (id: string) => api.post(`/tasks/${id}/claim`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const batch = useMutation({
    mutationFn: () => api.post('/signatures/batch', { items: (toSign.data?.items ?? []).map((d: any) => ({ instanceId: d.instanceId, docKey: d.docKey })) }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const markRead = useMutation({ mutationFn: () => api.post('/notifications/read'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });

  const mine = (tasks.data?.items ?? []).filter((t) => !t.inQueue);
  const queue = (tasks.data?.items ?? []).filter((t) => t.inQueue);
  const groups = group(mine, today);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Bună ziua, {me.fullName.split(' ')[0]}</h1>
          <div className="sub">
            {mine.length} sarcini în lucru · {queue.length} în coada comună · {toSign.data?.items.length ?? 0} documente de semnat
          </div>
        </div>
        <Link to="/dosar-nou" className="button primary">
          Dosar nou
        </Link>
      </div>
      {me.replacing.length > 0 && (
        <div className="alert info">
          Îi înlocuiți pe: {me.replacing.map((r) => r.fullName).join(', ')}. Sarcinile lor apar mai jos; acțiunile se înregistrează „în numele” lor.
        </div>
      )}
      <ErrorAlert error={tasks.error ?? claim.error} />
      <div className="grid-2">
        <div className="stack">
          {tasks.isLoading ? (
            <Loading />
          ) : mine.length === 0 ? (
            <Card title="Sarcinile mele">
              <Empty>Nu aveți sarcini deschise.</Empty>
            </Card>
          ) : (
            Object.entries(groups)
              .filter(([, list]) => list.length)
              .map(([label, list]) => (
                <Card key={label} title={`${label} (${list.length})`} flush>
                  <TaskTable tasks={list} today={today} />
                </Card>
              ))
          )}
          {queue.length > 0 && (
            <Card title={`Coada comună (${queue.length})`} flush>
              <TaskTable tasks={queue} today={today} claim={(id) => claim.mutate(id)} />
            </Card>
          )}
        </div>
        <div className="stack">
          <Card
            title="Documente de semnat"
            actions={
              (toSign.data?.items.length ?? 0) > 1 && (
                <button className="primary small" disabled={batch.isPending} onClick={() => batch.mutate()}>
                  {batch.isPending ? 'Se semnează…' : `Semnează toate (${toSign.data.items.length})`}
                </button>
              )
            }
            flush
          >
            {batch.data && (
              <div className={`alert ${batch.data.signed === batch.data.results.length ? 'success' : 'warning'} small`} style={{ margin: 8 }}>
                Semnate: {batch.data.signed} din {batch.data.results.length}.
                {batch.data.results.filter((r: any) => !r.ok).map((r: any, i: number) => (
                  <div key={i}>{r.error}</div>
                ))}
              </div>
            )}
            {toSign.data?.items.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {toSign.data.items.map((d: any) => (
                  <li key={`${d.taskId}-${d.docKey}`} style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--c-border)' }}>
                    <Link to={`/dosare/${d.instanceId}#documente`}>{d.documentTitle}</Link>
                    <div className="muted small">
                      {d.instanceTitle} · {d.stepName}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Nimic de semnat.</Empty>
            )}
          </Card>
          <Card
            title="Notificări"
            actions={
              (notifications.data?.unread ?? 0) > 0 && (
                <button className="small" onClick={() => markRead.mutate()}>
                  Marchează citite
                </button>
              )
            }
            flush
          >
            {notifications.data?.items.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {notifications.data.items.slice(0, 12).map((n: any) => (
                  <li key={n.id} style={{ padding: '0.6rem 1rem', borderBottom: '1px solid var(--c-border)', fontWeight: n.read_at ? 400 : 600 }}>
                    {n.instance_id ? <Link to={`/dosare/${n.instance_id}`}>{n.payload.title}</Link> : n.payload.title}
                    <div className="muted small">{fmtDateTime(n.created_at)}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>Nicio notificare.</Empty>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
