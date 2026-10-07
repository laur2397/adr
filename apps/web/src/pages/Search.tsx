import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { Card, Empty, Loading, StatusBadge } from '../components/ui';
import { fmtDateTime } from '../format';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const r = useQuery({ queryKey: ['search', q], queryFn: () => api.get(`/search?q=${encodeURIComponent(q)}`), enabled: q.length >= 2 });
  return (
    <div className="stack">
      <h1>Rezultate pentru „{q}”</h1>
      {r.isLoading && <Loading />}
      {r.data && (
        <>
          <Card title={`Dosare (${r.data.instances.length})`} flush>
            {r.data.instances.length ? (
              <table className="data">
                <tbody>
                  {r.data.instances.map((i: any) => (
                    <tr key={i.id}>
                      <td>
                        <Link to={`/dosare/${i.id}`}>{i.title}</Link>
                        <div className="small muted">
                          {i.reference_no ? `Nr. ${i.reference_no} · ` : ''}
                          {i.definition_name}
                        </div>
                        <div className="small">{i.snippet}</div>
                      </td>
                      <td className="right">
                        <StatusBadge status={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>Niciun dosar găsit (căutarea include câmpurile, tabelele, comentariile și titlurile documentelor).</Empty>
            )}
          </Card>
          {r.data.entries.length > 0 && (
            <Card title={`Înregistrări în registre (${r.data.entries.length})`} flush>
              <table className="data">
                <tbody>
                  {r.data.entries.map((e: any) => (
                    <tr key={e.id}>
                      <td className="nowrap">{e.number_display}</td>
                      <td>{e.register_name}</td>
                      <td>{e.subject}</td>
                      <td className="nowrap">{fmtDateTime(e.registered_at)}</td>
                      <td>{e.instance_id && <Link to={`/dosare/${e.instance_id}`}>dosar</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
