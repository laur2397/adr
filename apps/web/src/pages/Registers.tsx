import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, can } from '../api';
import { Card, Empty, ErrorAlert, Loading, Modal, useMe } from '../components/ui';
import { fmtDateTime } from '../format';

function NewEntry({ registerKey, onDone }: { registerKey: string; onDone: (r: any) => void }) {
  const [direction, setDirection] = useState<'in' | 'out' | 'internal'>('in');
  const [startP5, setStartP5] = useState(true);
  const [category, setCategory] = useState('corespondenta');
  const create = useMutation({ mutationFn: (body: unknown) => api.post(`/registers/${registerKey}/entries`, body), onSuccess: onDone });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const party = { name: String(f.get('name') ?? ''), cui: String(f.get('cui') ?? '') || null, email: String(f.get('email') ?? '') || null, address: String(f.get('address') ?? '') || null };
    create.mutate({
      direction,
      subject: f.get('subject'),
      channel: f.get('channel'),
      sender: direction === 'in' ? party : undefined,
      recipient: direction === 'out' ? party : undefined,
      startProcess: direction === 'in' && startP5 && registerKey === 'general' ? { definitionKey: 'p5_correspondence', fields: { category } } : undefined,
    });
  };
  return (
    <form onSubmit={submit}>
      <ErrorAlert error={create.error} />
      <fieldset className="row" style={{ border: 0, padding: 0, marginBottom: '0.75rem' }}>
        <legend className="field-label">Tip</legend>
        {(['in', 'out', 'internal'] as const).map((d) => (
          <label key={d} className="row">
            <input type="radio" name="direction" checked={direction === d} onChange={() => setDirection(d)} /> {d === 'in' ? 'Intrare' : d === 'out' ? 'Ieșire' : 'Intern'}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="label">
          Conținut pe scurt<span className="req">*</span>
        </span>
        <textarea name="subject" required />
      </label>
      {direction !== 'internal' && (
        <div className="form-grid">
          <label className="field">
            <span className="label">
              {direction === 'in' ? 'Emitent' : 'Destinatar'}
              <span className="req">*</span>
            </span>
            <input name="name" required />
          </label>
          <label className="field">
            <span className="label">CUI (persoane juridice)</span>
            <input name="cui" />
          </label>
          <label className="field">
            <span className="label">E-mail</span>
            <input name="email" type="email" />
          </label>
          <label className="field">
            <span className="label">Adresă</span>
            <input name="address" />
          </label>
        </div>
      )}
      <label className="field">
        <span className="label">Canal</span>
        <select name="channel" defaultValue="desk">
          <option value="desk">Ghișeu</option>
          <option value="email">E-mail</option>
          <option value="post">Poștă</option>
          <option value="portal">Portal</option>
          <option value="mysmis">MySMIS</option>
        </select>
      </label>
      {direction === 'in' && registerKey === 'general' && (
        <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
          <label className="row">
            <input type="checkbox" checked={startP5} onChange={(e) => setStartP5(e.target.checked)} /> Deschide dosar de corespondență (rezoluție, răspuns, termen)
          </label>
          {startP5 && (
            <label className="field" style={{ marginTop: 8 }}>
              <span className="label">Categorie (stabilește termenul de răspuns)</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="corespondenta">Corespondență generală (30 de zile)</option>
                <option value="petitie">Petiție – OG 27/2002 (30 de zile)</option>
                <option value="informatii_544">Informații publice – Legea 544/2001 (10 zile)</option>
              </select>
            </label>
          )}
        </div>
      )}
      <button className="primary" type="submit" disabled={create.isPending}>
        {create.isPending ? 'Se înregistrează…' : 'Înregistrează'}
      </button>
    </form>
  );
}

export function Registers() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { key = 'general' } = useParams();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const registers = useQuery({ queryKey: ['registers'], queryFn: () => api.get('/registers') });
  const entries = useQuery({ queryKey: ['register', key, search], queryFn: () => api.get(`/registers/${key}/entries?q=${encodeURIComponent(search)}`) });
  const current = registers.data?.items.find((r: any) => r.key === key);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{current?.name ?? 'Registre'}</h1>
          <label className="row small">
            <span className="sr-only">Registrul</span>
            <select value={key} onChange={(e) => navigate(`/registre/${e.target.value}`)} style={{ width: 'auto' }}>
              {registers.data?.items.map((r: any) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
            {current?.last_number && <span className="muted">ultimul număr în anul curent: {current.last_number}</span>}
          </label>
        </div>
        <div className="row">
          <a className="button" href={`/api/v1/registers/${key}/entries?format=xlsx&q=${encodeURIComponent(search)}`}>
            Export Excel
          </a>
          {can.register(me) && (
            <button className="primary" onClick={() => setOpen(true)}>
              Înregistrare nouă
            </button>
          )}
        </div>
      </div>
      {created && (
        <div className="alert success" role="status">
          Înregistrat cu nr. <strong>{created.number_display}</strong>.{' '}
          {created.instanceId && <Link to={`/dosare/${created.instanceId}`}>Deschide dosarul de corespondență</Link>}
        </div>
      )}
      <form
        role="search"
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <label className="sr-only" htmlFor="reg-q">
          Caută în registru
        </label>
        <input id="reg-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="număr, emitent, conținut" style={{ maxWidth: 420 }} />
        <button type="submit">Caută</button>
      </form>
      <ErrorAlert error={entries.error} />
      <Card flush>
        {entries.isLoading ? (
          <Loading />
        ) : !entries.data?.items.length ? (
          <Empty>Nicio înregistrare.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Număr</th>
                  <th>Data</th>
                  <th>Tip</th>
                  <th>Emitent / destinatar</th>
                  <th>Conținut</th>
                  <th>Conexat</th>
                  <th>Dosar</th>
                </tr>
              </thead>
              <tbody>
                {entries.data.items.map((e: any) => (
                  <tr key={e.id}>
                    <td className="nowrap">{e.number_display}</td>
                    <td className="nowrap">{fmtDateTime(e.registered_at)}</td>
                    <td>{e.direction_label}</td>
                    <td>{e.sender ?? e.recipient ?? e.department ?? '—'}</td>
                    <td>
                      {e.subject}
                      {e.resolution && <div className="muted small">Rezoluție: {e.resolution}</div>}
                    </td>
                    <td>{e.related_number ?? ''}</td>
                    <td>{e.instance_id ? <Link to={`/dosare/${e.instance_id}`}>deschide</Link> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Modal open={open} title="Înregistrare nouă" onClose={() => setOpen(false)}>
        {open && (
          <NewEntry
            registerKey={key}
            onDone={(r) => {
              setOpen(false);
              setCreated(r);
              qc.invalidateQueries({ queryKey: ['register', key] });
              qc.invalidateQueries({ queryKey: ['registers'] });
            }}
          />
        )}
      </Modal>
    </div>
  );
}
