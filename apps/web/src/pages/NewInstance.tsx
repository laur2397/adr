import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { Card, ErrorAlert } from '../components/ui';
import { fmtAmount } from '../format';

export function NewInstance() {
  const navigate = useNavigate();
  const defs = useQuery({ queryKey: ['process-definitions'], queryFn: () => api.get<any[]>('/process-definitions') });
  const [definitionKey, setDefinitionKey] = useState('');
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const def = defs.data?.find((d) => d.key === definitionKey);
  const needsProject = def?.subject?.requires?.includes('project');
  const projects = useQuery({ queryKey: ['projects', q], queryFn: () => api.get(`/projects?q=${encodeURIComponent(q)}`), enabled: Boolean(needsProject) });
  const start = useMutation({
    mutationFn: () => api.post<{ id: string }>('/instances', { definitionKey, projectId: projectId || undefined }),
    onSuccess: (r) => navigate(`/dosare/${r.id}`),
  });

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <h1>Dosar nou</h1>
      <ErrorAlert error={start.error} />
      <Card title="1. Tipul dosarului">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Tipul dosarului</legend>
          {defs.data
            ?.filter((d) => d.key !== 'p5_correspondence')
            .map((d) => (
              <label key={d.key} className="row" style={{ padding: '0.4rem 0' }}>
                <input type="radio" name="def" value={d.key} checked={definitionKey === d.key} onChange={() => setDefinitionKey(d.key)} />
                <span>
                  {d.name} <span className="muted small">v{d.version}</span>
                </span>
              </label>
            ))}
        </fieldset>
        <p className="muted small">Corespondența generală se înregistrează din Registre → Înregistrare nouă.</p>
      </Card>
      {needsProject && (
        <Card title="2. Proiectul">
          <label className="field">
            <span className="label">Caută după cod SMIS, titlu sau beneficiar</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  <th>Cod SMIS</th>
                  <th>Proiect</th>
                  <th>Beneficiar</th>
                  <th className="num">Valoare eligibilă</th>
                </tr>
              </thead>
              <tbody>
                {projects.data?.items.map((p: any) => (
                  <tr key={p.id}>
                    <td>
                      <input type="radio" name="project" aria-label={`Alege proiectul ${p.smis_code}`} checked={projectId === p.id} onChange={() => setProjectId(p.id)} />
                    </td>
                    <td>{p.smis_code}</td>
                    <td>{p.title}</td>
                    <td>{p.beneficiary_name}</td>
                    <td className="num">{fmtAmount(p.eligible_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <div>
        <button className="primary" disabled={!definitionKey || (needsProject && !projectId) || start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? 'Se creează…' : 'Creează dosarul'}
        </button>
      </div>
    </div>
  );
}
