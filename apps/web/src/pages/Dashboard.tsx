import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Card, Empty, ErrorAlert, Loading } from '../components/ui';
import { fmtDateTime } from '../format';

export function Dashboard() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useQuery({ queryKey: ['dashboard', from, to], queryFn: () => api.get(`/dashboard?from=${from}&to=${to}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const d = q.data;
  const totals = d.deadlines.reduce((a: any, x: any) => ({ met: a.met + x.met, breached: a.breached + x.breached, overdue: a.overdue + x.overdue_running, running: a.running + x.running }), { met: 0, breached: 0, overdue: 0, running: 0 });
  const rate = totals.met + totals.breached ? Math.round((100 * totals.met) / (totals.met + totals.breached)) : null;
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Tablou de bord</h1>
        <div className="row">
          <label className="row small">
            De la <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
          </label>
          <label className="row small">
            Până la <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
          </label>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{d.volume.reduce((a: number, v: any) => a + v.active, 0)}</div>
          <div className="l">dosare în lucru</div>
        </div>
        <div className="kpi">
          <div className="v">{totals.running}</div>
          <div className="l">termene în curs</div>
        </div>
        <div className="kpi">
          <div className="v" style={{ color: totals.overdue ? 'var(--c-danger)' : undefined }}>{totals.overdue}</div>
          <div className="l">termene depășite (în curs)</div>
        </div>
        <div className="kpi">
          <div className="v">{rate === null ? '—' : `${rate}%`}</div>
          <div className="l">termene respectate (închise)</div>
        </div>
        <div className="kpi">
          <div className="v">{d.blocked.length}</div>
          <div className="l">sarcini nemișcate de peste 5 zile</div>
        </div>
      </div>
      <div className="grid-2">
        <Card title="Volum pe expert" flush>
          {d.workload.length === 0 ? (
            <Empty>Nicio sarcină repartizată.</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Expert</th>
                  <th className="num">Sarcini deschise</th>
                  <th className="num">Depășite</th>
                  <th className="num">Vechime medie (zile)</th>
                </tr>
              </thead>
              <tbody>
                {d.workload.map((w: any) => (
                  <tr key={w.id}>
                    <td>{w.full_name}</td>
                    <td className="num">{w.open_tasks}</td>
                    <td className="num">{w.overdue_tasks}</td>
                    <td className="num">{String(w.avg_age_days).replace('.', ',')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Cozi comune" flush>
          {d.queues.length === 0 ? (
            <Empty>Cozile sunt goale.</Empty>
          ) : (
            <table className="data">
              <tbody>
                {d.queues.map((x: any) => (
                  <tr key={x.name}>
                    <td>{x.name}</td>
                    <td className="num">{x.open_tasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="Termene" flush>
        <table className="data">
          <thead>
            <tr>
              <th>Termen</th>
              <th className="num">În curs</th>
              <th className="num">Depășite în curs</th>
              <th className="num">Respectate</th>
              <th className="num">Depășite</th>
            </tr>
          </thead>
          <tbody>
            {d.deadlines.map((x: any) => (
              <tr key={x.name}>
                <td>{x.name}</td>
                <td className="num">{x.running}</td>
                <td className="num">{x.overdue_running}</td>
                <td className="num">{x.met}</td>
                <td className="num">{x.breached}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Timp mediu pe pas" flush>
        {d.stepTimes.length === 0 ? (
          <Empty>Încă nu există pași finalizați.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Proces</th>
                <th>Pas</th>
                <th className="num">Treceri</th>
                <th className="num">Medie (zile)</th>
                <th className="num">Maxim (zile)</th>
              </tr>
            </thead>
            <tbody>
              {d.stepTimes.map((x: any, i: number) => (
                <tr key={i}>
                  <td>{x.process}</td>
                  <td>{x.step_name}</td>
                  <td className="num">{x.passes}</td>
                  <td className="num">{String(x.avg_days).replace('.', ',')}</td>
                  <td className="num">{String(x.max_days).replace('.', ',')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Blocaje (sarcini deschise de peste 5 zile)" flush>
        {d.blocked.length === 0 ? (
          <Empty>Niciun blocaj.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Dosar</th>
                <th>Pas</th>
                <th>La</th>
                <th>Din</th>
                <th className="num">Zile</th>
              </tr>
            </thead>
            <tbody>
              {d.blocked.map((b: any) => (
                <tr key={`${b.id}-${b.step}`}>
                  <td>
                    <Link to={`/dosare/${b.id}`}>{b.title}</Link>
                  </td>
                  <td>{b.step}</td>
                  <td>{b.assignee ?? 'coadă'}</td>
                  <td>{fmtDateTime(b.created_at)}</td>
                  <td className="num">{String(b.days_waiting).replace('.', ',')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
