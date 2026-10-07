import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, can } from '../api';
import { Card, DueBadge, Empty, ErrorAlert, Loading, StatusBadge, useMe } from '../components/ui';
import { fmtDate, todayIso } from '../format';

export function Instances() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const defs = useQuery({ queryKey: ['process-definitions'], queryFn: () => api.get<any[]>('/process-definitions') });
  const query = params.toString();
  const list = useQuery({ queryKey: ['instances', query], queryFn: () => api.get(`/instances?${query}`) });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  };
  const today = todayIso();

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Dosare</h1>
        {can.dashboard(me) && (
          <a className="button" href={`/api/v1/exports/instances.xlsx${params.get('definition') ? `?definition=${params.get('definition')}` : ''}`}>
            Export Excel
          </a>
        )}
      </div>
      <Card>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q);
          }}
          role="search"
        >
          <label className="field">
            <span className="label">Caută</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="titlu, număr, beneficiar, cod SMIS" />
          </label>
          <label className="field">
            <span className="label">Proces</span>
            <select value={params.get('definition') ?? ''} onChange={(e) => set('definition', e.target.value)}>
              <option value="">Toate</option>
              {defs.data?.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Stare</span>
            <select value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
              <option value="">Toate</option>
              <option value="open">În lucru</option>
              <option value="closed">Închise</option>
            </select>
          </label>
          <label className="field">
            <span className="label">Filtre</span>
            <select
              value={params.get('assignee') === 'me' ? 'me' : params.get('due') === 'overdue' ? 'overdue' : ''}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.delete('assignee');
                next.delete('due');
                if (e.target.value === 'me') next.set('assignee', 'me');
                if (e.target.value === 'overdue') next.set('due', 'overdue');
                setParams(next);
              }}
            >
              <option value="">Fără</option>
              <option value="me">Doar la mine</option>
              <option value="overdue">Termen depășit</option>
            </select>
          </label>
          <label className="field">
            <span className="label">Program</span>
            <input value={params.get('program') ?? ''} onChange={(e) => set('program', e.target.value)} placeholder="ex. PR" />
          </label>
          <label className="field">
            <span className="label">Județ</span>
            <input value={params.get('county') ?? ''} onChange={(e) => set('county', e.target.value.toUpperCase())} placeholder="ex. TIMIȘ" />
          </label>
        </form>
      </Card>
      <ErrorAlert error={list.error} />
      <Card flush>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.items.length ? (
          <Empty>Niciun dosar nu corespunde filtrelor.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data cards-mobile">
              <thead>
                <tr>
                  <th>Dosar</th>
                  <th>Beneficiar</th>
                  <th>Pas curent</th>
                  <th>Termen</th>
                  <th>Stare</th>
                  <th>Pornit</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((i: any) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/dosare/${i.id}`}>{i.title}</Link>
                      <div className="muted small">
                        {i.reference_no ? `Nr. ${i.reference_no} · ` : ''}
                        {i.definition_name}
                      </div>
                    </td>
                    <td data-label="Beneficiar">
                      {i.beneficiary_name ?? '—'}
                      {i.smis_code && <div className="muted small">SMIS {i.smis_code}</div>}
                    </td>
                    <td data-label="Pas curent">
                      {i.current_steps ?? '—'}
                      {i.current_assignees && <div className="muted small">{i.current_assignees}</div>}
                    </td>
                    <td data-label="Termen">{i.status === 'active' ? <DueBadge due={i.next_due} today={today} /> : '—'}</td>
                    <td data-label="Stare">
                      <StatusBadge status={i.status} />
                    </td>
                    <td className="nowrap" data-label="Pornit">{fmtDate(i.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
