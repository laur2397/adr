import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, can } from '../api';
import { Badge, Card, Empty, ErrorAlert, Loading, Modal, useMe } from '../components/ui';
import { fmtDate, fmtDateTime } from '../format';

export function Archive() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['archive'], queryFn: () => api.get('/archive') });
  const disposal = useQuery({ queryKey: ['archive-disposal'], queryFn: () => api.get('/archive/disposal') });
  const [fileId, setFileId] = useState<string | null>(null);
  const [disposeId, setDisposeId] = useState<string | null>(null);
  const [decision, setDecision] = useState('');
  const file = useQuery({ queryKey: ['archive-file', fileId], queryFn: () => api.get(`/archive/files/${fileId}`), enabled: Boolean(fileId) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['archive'] }).then(() => qc.invalidateQueries({ queryKey: ['archive-disposal'] }));
  const close = useMutation({ mutationFn: (id: string) => api.post(`/archive/files/${id}/close`), onSuccess: refresh });
  const open = useMutation({ mutationFn: (b: { nomenclatureItemId: string; year: number }) => api.post('/archive/files', b), onSuccess: refresh });
  const dispose = useMutation({
    mutationFn: () => api.post(`/archive/files/${disposeId}/dispose`, { decision }),
    onSuccess: () => {
      setDisposeId(null);
      setDecision('');
      refresh();
    },
  });
  const manage = can.register(me);
  const approver = me.roles.some((r) => ['director', 'functional_admin'].includes(r));
  if (q.isLoading) return <Loading />;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Arhiva</h1>
          <div className="sub">
            Nomenclatorul arhivistic, dosarele pe ani, inventare și propunerile de eliminare la expirarea termenului de păstrare (Legea 16/1996). Documentele se păstrează cu hash SHA-256 pentru integritate.
          </div>
        </div>
      </div>
      <ErrorAlert error={q.error ?? close.error ?? open.error} />
      <Card title="Nomenclatorul arhivistic" flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Indicativ</th>
                <th>Dosar</th>
                <th>Păstrare</th>
                <th>Dosare pe ani</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((n: any) => (
                <tr key={n.id}>
                  <td className="mono">{n.indicative}</td>
                  <td>
                    {n.title}
                    {n.department && <div className="small muted">{n.department}</div>}
                  </td>
                  <td>{n.retention_years ? `${n.retention_years} ani` : <Badge tone="blue">permanent</Badge>}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {n.files.map((f: any) => (
                        <span key={f.id} className="row" style={{ gap: 4, border: '1px solid var(--c-border)', borderRadius: 6, padding: '2px 6px' }}>
                          <button className="link" onClick={() => setFileId(f.id)}>
                            {f.year}
                          </button>
                          <span className="small muted">
                            {f.entries + f.documents} buc.
                          </span>
                          {f.disposedAt ? <Badge>eliminat</Badge> : f.closedAt ? <Badge tone="green">închis</Badge> : <Badge tone="yellow">deschis</Badge>}
                          {manage && !f.closedAt && (
                            <button className="small" onClick={() => close.mutate(f.id)} title="Închide dosarul la sfârșitul anului">
                              Închide
                            </button>
                          )}
                        </span>
                      ))}
                      {manage && !n.files.some((f: any) => f.year === q.data.year) && (
                        <button className="small" onClick={() => open.mutate({ nomenclatureItemId: n.id, year: q.data.year })}>
                          Deschide {q.data.year}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Propuneri de eliminare (termen de păstrare expirat)" flush>
        {!disposal.data?.items.length ? (
          <Empty>Nu există dosare cu termenul de păstrare expirat.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Dosar</th>
                <th>An</th>
                <th>Expirat în</th>
                <th>Stare</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {disposal.data.items.map((d: any) => (
                <tr key={d.id}>
                  <td>
                    {d.indicative} – {d.title}
                  </td>
                  <td>{d.year}</td>
                  <td>{d.expired_in}</td>
                  <td>{d.disposed_at ? <span className="small">eliminat {fmtDate(d.disposed_at.slice(0, 10))}: {d.disposal_decision}</span> : <Badge tone="yellow">propus</Badge>}</td>
                  <td>
                    {approver && !d.disposed_at && (
                      <button className="small danger" onClick={() => setDisposeId(d.id)}>
                        Aprobă eliminarea
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {fileId && (
        <Modal open title={file.data ? `${file.data.indicative} – ${file.data.title}, ${file.data.year}` : 'Dosar arhivistic'} onClose={() => setFileId(null)} footer={<>
          {fileId && <a className="button" href={`/api/v1/archive/files/${fileId}?format=xlsx`}>Inventar Excel</a>}
          <button onClick={() => setFileId(null)}>Închide</button>
        </>}>
          {!file.data ? (
            <Loading />
          ) : (
            <div className="stack">
              <p className="small">
                Păstrare: {file.data.retention_years ? `${file.data.retention_years} ani (până în ${file.data.year + file.data.retention_years})` : 'permanent'} ·{' '}
                {file.data.closed_at ? `închis la ${fmtDateTime(file.data.closed_at)}` : 'deschis'}
              </p>
              <h3>Înregistrări ({file.data.entries.length})</h3>
              <ul className="small">
                {file.data.entries.map((e: any, i: number) => (
                  <li key={i}>
                    {e.number_display} – {e.subject}
                  </li>
                ))}
              </ul>
              <h3>Documente ({file.data.documents.length})</h3>
              <ul className="small">
                {file.data.documents.map((d: any) => (
                  <li key={d.id}>
                    {d.title} {d.instance_id && <Link to={`/dosare/${d.instance_id}`}>({d.reference_no ?? d.instance_title})</Link>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}
      <Modal open={Boolean(disposeId)} title="Aprobarea eliminării" onClose={() => setDisposeId(null)} footer={<>
        <button onClick={() => setDisposeId(null)}>Renunță</button>
        <button className="danger" disabled={!decision.trim() || dispose.isPending} onClick={() => dispose.mutate()}>Aprobă eliminarea</button>
      </>}>
        <ErrorAlert error={dispose.error} />
        <label className="field">
          <span className="label">Decizia comisiei de selecționare și avizul Arhivelor Naționale</span>
          <textarea value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="ex. Proces-verbal comisie nr. 12/2026, confirmat de Arhivele Naționale – SJAN Timiș cu adresa nr. …" />
        </label>
      </Modal>
    </div>
  );
}
