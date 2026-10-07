import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { fmtAmount, fmtDateTime } from '../format';
import { Card, Empty, ErrorAlert, Modal } from './ui';

export function CommentsPanel({ instanceId }: { instanceId: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const q = useQuery({ queryKey: ['comments', instanceId], queryFn: () => api.get(`/instances/${instanceId}/comments`) });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users'), staleTime: 300_000 });
  const add = useMutation({
    mutationFn: () => api.post(`/instances/${instanceId}/comments`, { body }),
    onSuccess: () => {
      setBody('');
      qc.invalidateQueries({ queryKey: ['comments', instanceId] });
    },
  });
  const mentionMatch = /@([a-z0-9._-]*)$/i.exec(body);
  const suggestions = mentionMatch
    ? (users.data?.items ?? []).filter((u: any) => u.username?.startsWith(mentionMatch[1]!.toLowerCase()) || u.full_name.toLowerCase().includes(mentionMatch[1]!.toLowerCase())).slice(0, 6)
    : [];
  return (
    <Card title={`Comentarii (${q.data?.items.length ?? 0})`}>
      {q.data?.items.length ? (
        <ol style={{ listStyle: 'none', margin: '0 0 1rem', padding: 0, display: 'grid', gap: 12 }}>
          {q.data.items.map((c: any) => (
            <li key={c.id} style={{ borderLeft: '3px solid var(--c-primary-soft)', paddingLeft: 12 }}>
              <div className="small">
                <strong>{c.author}</strong> <span className="muted">· {c.job_title} · {fmtDateTime(c.created_at)}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {c.body.split(/(@[a-z0-9._-]+)/gi).map((part: string, i: number) => (part.startsWith('@') ? <strong key={i} style={{ color: 'var(--c-primary)' }}>{part}</strong> : part))}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>Niciun comentariu încă. Comentariile rămân în dosar și în jurnalul de audit.</Empty>
      )}
      <ErrorAlert error={add.error} />
      <label className="field">
        <span className="label">Comentariu nou</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Scrieți @ urmat de numele unui coleg pentru a-l anunța (de ex. @sef.svf)" />
      </label>
      {suggestions.length > 0 && (
        <div className="row small" style={{ marginTop: -8, marginBottom: 8 }}>
          {suggestions.map((u: any) => (
            <button key={u.id} type="button" className="small" onClick={() => setBody(body.replace(/@([a-z0-9._-]*)$/i, `@${u.username} `))}>
              @{u.username} – {u.full_name}
            </button>
          ))}
        </div>
      )}
      <button className="primary" disabled={!body.trim() || add.isPending} onClick={() => add.mutate()}>
        Adaugă comentariul
      </button>
    </Card>
  );
}

export function CoiBanner({ instanceId, coi }: { instanceId: string; coi: { required: boolean; declared: boolean; hasConflict: boolean } }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [details, setDetails] = useState('');
  const info = useQuery({ queryKey: ['coi', instanceId], queryFn: () => api.get(`/instances/${instanceId}/coi`), enabled: open });
  const declare = useMutation({
    mutationFn: () => api.post(`/instances/${instanceId}/coi`, { hasConflict: conflict, details }),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries();
    },
  });
  if (!coi.required || (coi.declared && !coi.hasConflict)) return null;
  if (coi.hasConflict) {
    return <div className="alert error">Ați declarat conflict de interese pentru acest dosar. Sarcina a fost trimisă șefului de serviciu pentru realocare.</div>;
  }
  return (
    <div className="alert warning row" style={{ justifyContent: 'space-between' }}>
      <span>
        <strong>Declarație privind conflictul de interese.</strong> Înainte de a lucra la acest dosar trebuie să declarați că nu vă aflați în conflict de interese.
      </span>
      <button className="primary small" onClick={() => setOpen(true)}>
        Completează declarația
      </button>
      <Modal
        open={open}
        title="Declarație privind conflictul de interese"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button onClick={() => setOpen(false)}>Renunță</button>
            <button className={conflict ? 'danger' : 'primary'} disabled={declare.isPending || (conflict && !details.trim())} onClick={() => declare.mutate()}>
              {conflict ? 'Declar conflict de interese' : 'Semnez declarația'}
            </button>
          </>
        }
      >
        <ErrorAlert error={declare.error} />
        <p style={{ fontStyle: 'italic' }}>{info.data?.statement ?? 'Se încarcă textul declarației…'}</p>
        <label className="row">
          <input type="checkbox" checked={conflict} onChange={(e) => setConflict(e.target.checked)} /> Mă aflu într-o situație de conflict de interese
        </label>
        {conflict && (
          <label className="field" style={{ marginTop: 8 }}>
            <span className="label">Descrieți situația</span>
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} />
            <span className="field-hint">Sarcina va fi retrasă de la dumneavoastră, iar șeful de serviciu va fi anunțat.</span>
          </label>
        )}
      </Modal>
    </div>
  );
}

export function DoubleFundingAlerts({ items }: { items: any[] }) {
  if (!items?.length) return null;
  return (
    <div className="alert error" role="alert">
      <strong>Posibilă dublă finanțare ({items.length}).</strong> Aceleași facturi apar și în alte dosare. Verificați înainte de a declara cheltuielile eligibile.
      <ul>
        {items.map((a, i) => (
          <li key={i}>
            Rândul {a.row + 1}: factura <strong>{a.invoiceNo}</strong> (CUI {a.supplierCui}, {fmtAmount(a.amount)} lei) apare și în{' '}
            <Link to={`/dosare/${a.otherInstanceId}`}>{a.otherReference ? `dosarul ${a.otherReference}` : a.otherTitle}</Link>
            {a.otherProject ? `, proiect SMIS ${a.otherProject}` : ''} ({fmtAmount(a.otherAmount)} lei){a.sameProject ? ' – același proiect' : ' – alt proiect'}
          </li>
        ))}
      </ul>
    </div>
  );
}
