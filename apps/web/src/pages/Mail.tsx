import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Badge, Card, Empty, ErrorAlert, Loading, Modal } from '../components/ui';
import { fmtDateTime } from '../format';

const STATUS: Record<string, [string, 'yellow' | 'green' | 'gray' | 'blue' | 'red']> = {
  pending: ['de procesat', 'yellow'],
  registered: ['înregistrat', 'green'],
  attached: ['atașat la dosar', 'blue'],
  ignored: ['ignorat', 'gray'],
  error: ['eroare', 'red'],
};

export function Mail() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [openId, setOpenId] = useState<string | null>(null);
  const [category, setCategory] = useState('corespondenta');
  const [reason, setReason] = useState('');
  const list = useQuery({ queryKey: ['mail', status], queryFn: () => api.get(`/mail?status=${status}`) });
  const mail = useQuery({ queryKey: ['mail-one', openId], queryFn: () => api.get(`/mail/${openId}`), enabled: Boolean(openId) });
  const done = () => {
    setOpenId(null);
    qc.invalidateQueries({ queryKey: ['mail'] });
  };
  const process = useMutation({ mutationFn: (b: unknown) => api.post(`/mail/${openId}/process`, b), onSuccess: done });
  const upload = useMutation({ mutationFn: (fd: FormData) => api.post('/mail/upload', fd), onSuccess: () => qc.invalidateQueries({ queryKey: ['mail'] }) });
  const row = list.data?.items.find((m: any) => m.id === openId);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Corespondență electronică</h1>
          <div className="sub">Mesajele primite pe adresa instituției așteaptă confirmarea registraturii înainte de a primi număr.</div>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate(new FormData(e.currentTarget));
            e.currentTarget.reset();
          }}
        >
          <input type="file" name="file" accept=".eml,message/rfc822" required style={{ maxWidth: 260 }} aria-label="Fișier .eml" />
          <button type="submit">Importă .eml</button>
        </form>
      </div>
      <ErrorAlert error={list.error ?? upload.error} />
      <div className="row">
        {Object.entries(STATUS).map(([k, [l]]) => (
          <button key={k} className={status === k ? 'primary small' : 'small'} onClick={() => setStatus(k)}>
            {l}
          </button>
        ))}
      </div>
      <Card flush>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.items.length ? (
          <Empty>Niciun mesaj.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Primit</th>
                <th>Expeditor</th>
                <th>Subiect</th>
                <th>Atașamente</th>
                <th>Stare</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((m: any) => (
                <tr key={m.id}>
                  <td className="nowrap">{fmtDateTime(m.received_at)}</td>
                  <td>
                    {m.from_name ?? m.from_address}
                    <div className="small muted">{m.from_address}</div>
                  </td>
                  <td>
                    <button className="link" onClick={() => setOpenId(m.id)}>
                      {m.subject}
                    </button>
                    {m.suggested_title && m.status === 'pending' && <div className="small">Pare răspuns la: {m.suggested_reference ?? m.suggested_title}</div>}
                    {m.number_display && <div className="small muted">Nr. {m.number_display}</div>}
                  </td>
                  <td>{m.attachments}</td>
                  <td>
                    <Badge tone={STATUS[m.status]?.[1]}>{STATUS[m.status]?.[0]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {openId && (
        <Modal open title={row?.subject ?? 'Mesaj'} onClose={() => setOpenId(null)} footer={<button onClick={() => setOpenId(null)}>Închide</button>}>
          {!mail.data ? (
            <Loading />
          ) : (
            <div className="stack">
              <ErrorAlert error={process.error} />
              <p className="small">
                De la <strong>{mail.data.from_name ?? mail.data.from_address}</strong> &lt;{mail.data.from_address}&gt; · {fmtDateTime(mail.data.received_at)}
              </p>
              <pre style={{ whiteSpace: 'pre-wrap', background: '#f7f8f9', padding: 10, borderRadius: 6, maxHeight: 220, overflow: 'auto', font: 'inherit' }}>{mail.data.body_text}</pre>
              <div className="row small">
                <a href={`/api/v1/mail/${openId}/files/-1`}>mesaj original (.eml)</a>
                {mail.data.attachments.map((a: any, i: number) => (
                  <a key={i} href={`/api/v1/mail/${openId}/files/${i}`}>
                    {a.fileName}
                  </a>
                ))}
              </div>
              {mail.data.status === 'pending' && (
                <>
                  {mail.data.suggested_instance_id && (
                    <div className="alert info small row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        Subiectul conține numărul unui dosar existent: <Link to={`/dosare/${mail.data.suggested_instance_id}`}>{row?.suggested_reference ?? row?.suggested_title}</Link>
                      </span>
                      <button className="primary small" onClick={() => process.mutate({ action: 'attach', instanceId: mail.data.suggested_instance_id })}>
                        Atașează la dosar
                      </button>
                    </div>
                  )}
                  <div className="card" style={{ padding: 12 }}>
                    <label className="field">
                      <span className="label">Înregistrează și deschide dosar de corespondență</span>
                      <select value={category} onChange={(e) => setCategory(e.target.value)}>
                        <option value="corespondenta">Corespondență generală</option>
                        <option value="petitie">Petiție (OG 27/2002)</option>
                        <option value="informatii_544">Informații publice (Legea 544/2001)</option>
                      </select>
                    </label>
                    <div className="row">
                      <button className="primary" onClick={() => process.mutate({ action: 'register', startProcess: { definitionKey: 'p5_correspondence', fields: { category } } })}>
                        Înregistrează + dosar
                      </button>
                      <button onClick={() => process.mutate({ action: 'register' })}>Doar înregistrează</button>
                    </div>
                  </div>
                  <div className="row">
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="motiv (ex. spam)" style={{ maxWidth: 260 }} aria-label="Motivul ignorării" />
                    <button className="danger small" disabled={!reason.trim()} onClick={() => process.mutate({ action: 'ignore', reason })}>
                      Ignoră
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
