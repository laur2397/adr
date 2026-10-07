import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Badge, Card, Empty, ErrorAlert, Loading } from '../components/ui';
import { fmtDate, todayIso } from '../format';

const RESULT_TONE: Record<string, 'green' | 'yellow' | 'red'> = { conform: 'green', conform_cu_recomandari: 'yellow', neconform: 'red' };

function VisitTable({ items, today }: { items: any[]; today: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Data</th>
            <th>Beneficiar / proiect</th>
            <th>Locul</th>
            <th>Inspector</th>
            <th>Stadiu</th>
            <th className="num">Foto</th>
            <th>Rezultat</th>
            <th>
              <span className="sr-only">Acțiuni</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((v) => {
            const date = v.visit_date ?? v.planned_date;
            const late = !v.visit_date && v.planned_date && v.planned_date < today && v.status === 'active';
            return (
              <tr key={v.id}>
                <td>
                  {date ? fmtDate(date) : <span className="muted">neprogramată</span>}
                  <div className="small muted">{v.visit_date ? 'efectuată' : v.planned_date ? (late ? 'programată – depășită' : 'programată') : ''}</div>
                </td>
                <td>
                  <Link to={`/dosare/${v.id}`}>{v.beneficiary_name ?? v.title}</Link>
                  <div className="small muted">
                    SMIS {v.smis_code}
                    {v.visit_reason_label ? ` · ${v.visit_reason_label}` : ''}
                  </div>
                </td>
                <td className="small">{v.location ?? '—'}</td>
                <td className="small">{v.inspector ?? '—'}</td>
                <td className="small">{v.status === 'active' ? (v.current_step ?? '—') : <Badge tone="gray">închis</Badge>}</td>
                <td className="num">
                  {v.photos}
                  {v.signed ? <div className="small muted">semnat</div> : null}
                </td>
                <td>{v.result ? <Badge tone={RESULT_TONE[v.result] ?? 'gray'}>{v.result_label}</Badge> : '—'}</td>
                <td className="right">
                  {v.mine && (
                    <Link className="button primary small" to={`/teren/${v.id}`}>
                      Pe teren
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Visits() {
  const q = useQuery({ queryKey: ['visits'], queryFn: () => api.get('/visits') });
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const today = todayIso();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const items: any[] = q.data.items;
  const open = items.filter((v) => v.status === 'active');
  const done = items.filter((v) => v.status !== 'active');
  const shown = filter === 'open' ? open : filter === 'done' ? done : items;
  const thisMonth = items.filter((v) => (v.visit_date ?? '').slice(0, 7) === today.slice(0, 7)).length;
  const withRecs = done.filter((v) => v.result === 'conform_cu_recomandari').length;
  const nonconform = items.filter((v) => v.result === 'neconform').length;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Vizite pe teren</h1>
          <div className="sub">Verificări la fața locului (art. 74 alin. 2 din Regulamentul (UE) 2021/1060): programate din eșantionare sau la cerere, efectuate cu modulul de teren.</div>
        </div>
        <Link to="/dosar-nou" className="button">
          Vizită la cerere
        </Link>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{open.length}</div>
          <div className="l">programate sau în lucru</div>
        </div>
        <div className="kpi">
          <div className="v">{thisMonth}</div>
          <div className="l">efectuate luna aceasta</div>
        </div>
        <div className="kpi">
          <div className="v">{withRecs}</div>
          <div className="l">încheiate cu recomandări</div>
        </div>
        <div className="kpi">
          <div className="v" style={{ color: nonconform ? 'var(--c-danger)' : undefined }}>{nonconform}</div>
          <div className="l">neconforme (sesizate la nereguli)</div>
        </div>
      </div>
      <div className="row">
        {(
          [
            ['open', `În curs (${open.length})`],
            ['done', `Încheiate (${done.length})`],
            ['all', `Toate (${items.length})`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={filter === k ? 'primary small' : 'small'} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <Card flush>{shown.length ? <VisitTable items={shown} today={today} /> : <Empty>Nicio vizită.</Empty>}</Card>
    </div>
  );
}
