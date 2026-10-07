import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Badge, Card, Empty, ErrorAlert, Loading } from '../components/ui';
import { fmtDateTime } from '../format';

function ScoreBar({ score }: { score: number }) {
  const tone = score >= 70 ? '#c0392b' : score >= 40 ? '#d4a017' : '#2e8b57';
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span style={{ display: 'inline-block', width: 90, height: 8, background: '#eef0f2', borderRadius: 4 }} aria-hidden="true">
        <span style={{ display: 'block', width: `${Math.min(100, score)}%`, height: 8, background: tone, borderRadius: 4 }} />
      </span>
      <span className="mono">{score.toFixed(1)}</span>
    </span>
  );
}

function SelectionTable({ items, labels }: { items: any[]; labels: Record<string, string> }) {
  const sorted = [...items].sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Dosar</th>
            <th>Scor de risc</th>
            <th>Factori</th>
            <th>Selectat</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((i) => (
            <tr key={i.instanceId} style={{ background: i.selected ? 'var(--c-primary-soft)' : undefined }}>
              <td>
                <Link to={`/dosare/${i.instanceId}`}>{i.referenceNo ?? i.title}</Link>
                <div className="small muted">{i.smisCode ? `SMIS ${i.smisCode}` : i.title}</div>
              </td>
              <td>
                <ScoreBar score={i.score} />
              </td>
              <td className="small">
                {Object.entries(i.factors as Record<string, number>)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${labels[k] ?? k}: ${v}`)
                  .join(' · ') || '—'}
              </td>
              <td>{i.selected ? <Badge tone="blue">{i.reason}</Badge> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Sampling() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['sampling'], queryFn: () => api.get('/sampling') });
  const defs = useQuery({ queryKey: ['process-definitions'], queryFn: () => api.get<any[]>('/process-definitions') });
  const [form, setForm] = useState({ name: '', definitionKey: 'p1_payment_request_check', from: '', to: '', method: 'risk_weighted', percent: 20, threshold: 70, seed: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const preview = useMutation({ mutationFn: () => api.post('/sampling', { ...form, preview: true }) });
  const create = useMutation({
    mutationFn: () => api.post('/sampling', { ...form, seed: form.seed || preview.data?.seed }),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ['sampling'] });
      setOpenId(r.id);
    },
  });
  const plan = useQuery({ queryKey: ['sampling', openId], queryFn: () => api.get(`/sampling/${openId}`), enabled: Boolean(openId) });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const labels = list.data?.factorLabels ?? {};

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Eșantionare pentru verificări la fața locului</h1>
          <div className="sub">
            Selecție pe bază de risc (art. 74 alin. 2 din Regulamentul (UE) 2021/1060). Sămânța și selecția se păstrează, astfel încât auditul poate reproduce eșantionul.
          </div>
        </div>
      </div>
      <Card title="Plan nou">
        <div className="form-grid">
          <label className="field">
            <span className="label">Denumire</span>
            <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="ex. Vizite trimestrul IV 2026" />
          </label>
          <label className="field">
            <span className="label">Proces</span>
            <select value={form.definitionKey} onChange={(e) => set('definitionKey', e.target.value)}>
              {defs.data?.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">De la</span>
            <input type="date" value={form.from} onChange={(e) => set('from', e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Până la</span>
            <input type="date" value={form.to} onChange={(e) => set('to', e.target.value)} />
          </label>
          <label className="field">
            <span className="label">Metodă</span>
            <select value={form.method} onChange={(e) => set('method', e.target.value)}>
              <option value="risk_weighted">Ponderată cu riscul</option>
              <option value="simple_random">Aleatorie simplă</option>
            </select>
          </label>
          <label className="field">
            <span className="label">Mărimea eșantionului (%)</span>
            <input type="number" min={1} max={100} value={form.percent} onChange={(e) => set('percent', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="label">Prag risc ridicat (selectat automat)</span>
            <input type="number" min={0} max={100} value={form.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
          </label>
          <label className="field">
            <span className="label">Sămânță (opțional)</span>
            <input value={form.seed} onChange={(e) => set('seed', e.target.value)} placeholder="generată automat" />
          </label>
        </div>
        <ErrorAlert error={preview.error ?? create.error} />
        <div className="row">
          <button onClick={() => preview.mutate()} disabled={preview.isPending}>
            Previzualizează
          </button>
          <button className="primary" onClick={() => create.mutate()} disabled={!form.name.trim() || create.isPending}>
            Salvează planul
          </button>
        </div>
        {list.data && (
          <p className="small muted" style={{ marginTop: 8 }}>
            Ponderi: {Object.entries(list.data.weights as Record<string, number>).map(([k, w]) => `${labels[k]} ${w}%`).join(' · ')}
          </p>
        )}
      </Card>
      {preview.data && !create.data && (
        <Card title={`Previzualizare: ${preview.data.sampleSize} din ${preview.data.populationSize} dosare (sămânța ${preview.data.seed})`} flush>
          <SelectionTable items={preview.data.items} labels={labels} />
        </Card>
      )}
      <Card title="Planuri salvate" flush>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.items.length ? (
          <Empty>Niciun plan de eșantionare.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Metodă</th>
                <th className="num">Eșantion</th>
                <th>Sămânță</th>
                <th>Creat</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p: any) => (
                <tr key={p.id}>
                  <td>
                    <button className="link" onClick={() => setOpenId(p.id)}>
                      {p.name}
                    </button>
                  </td>
                  <td>{p.method === 'risk_weighted' ? 'ponderată cu riscul' : 'aleatorie simplă'}</td>
                  <td className="num">
                    {p.sample_size} / {p.population_size}
                  </td>
                  <td className="mono small">{p.seed}</td>
                  <td>
                    {p.created_by_name}, {fmtDateTime(p.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {plan.data && (
        <Card title={plan.data.name} flush>
          <p className="small" style={{ padding: '0.75rem 1rem 0' }}>
            {plan.data.justification}
          </p>
          <SelectionTable items={plan.data.items} labels={labels} />
        </Card>
      )}
    </div>
  );
}
