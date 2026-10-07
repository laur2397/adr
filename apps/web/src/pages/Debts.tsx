import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Badge, Card, Empty, ErrorAlert, Loading, Modal, useMe } from '../components/ui';
import { fmtAmount, fmtDate, todayIso } from '../format';

const STATUS: Record<string, [string, 'red' | 'yellow' | 'green' | 'gray' | 'blue']> = {
  open: ['neîncasat', 'red'],
  partially_paid: ['încasat parțial', 'yellow'],
  paid: ['încasat', 'green'],
  contested: ['contestat', 'blue'],
  cancelled: ['anulat', 'gray'],
};

function DebtDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['debt', id], queryFn: () => api.get(`/debts/${id}`) });
  const pay = useMutation({
    mutationFn: (b: unknown) => api.post(`/debts/${id}/payments`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['debt'] }).then(() => qc.invalidateQueries({ queryKey: ['debts'] })),
  });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    pay.mutate(f);
    e.currentTarget.reset();
  };
  const canPay = me.roles.some((r) => ['accountant', 'functional_admin'].includes(r));
  return (
    <Modal open title={d.data ? `Titlul de creanță ${d.data.title_number}` : 'Creanță'} onClose={onClose} footer={<button onClick={onClose}>Închide</button>}>
      {!d.data ? (
        <Loading />
      ) : (
        <div className="stack">
          <p>
            <strong>{d.data.beneficiary_name}</strong> (CUI {d.data.cui}) · proiect SMIS {d.data.smis_code}
            <br />
            Debit {fmtAmount(d.data.principal)} lei · încasat {fmtAmount(d.data.paid)} lei · <strong>sold {fmtAmount(d.data.balance)} lei</strong> · scadență {fmtDate(d.data.due_date)}
          </p>
          <p className="small">{d.data.reason}</p>
          {d.data.instance_id && <Link to={`/dosare/${d.data.instance_id}`}>Deschide dosarul de constatare</Link>}
          <table className="data">
            <thead>
              <tr>
                <th>Data</th>
                <th>Document</th>
                <th className="num">Sumă</th>
              </tr>
            </thead>
            <tbody>
              {d.data.payments.map((p: any) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.paid_on)}</td>
                  <td>
                    {p.reference} {p.kind === 'offset' && <Badge>compensare</Badge>}
                  </td>
                  <td className="num">{fmtAmount(p.amount)}</td>
                </tr>
              ))}
              {!d.data.payments.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    Nicio încasare.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {canPay && Number(d.data.balance) > 0 && d.data.status !== 'cancelled' && (
            <form onSubmit={submit} className="form-grid">
              <ErrorAlert error={pay.error} />
              <label className="field">
                <span className="label">Sumă încasată</span>
                <input name="amount" className="num" required />
              </label>
              <label className="field">
                <span className="label">Data</span>
                <input name="paidOn" type="date" defaultValue={todayIso()} required />
              </label>
              <label className="field">
                <span className="label">Document (OP nr./data)</span>
                <input name="reference" required />
              </label>
              <label className="field">
                <span className="label">Tip</span>
                <select name="kind">
                  <option value="payment">Plată</option>
                  <option value="offset">Compensare din cereri de plată</option>
                </select>
              </label>
              <div className="wide">
                <button className="primary" type="submit">
                  Înregistrează încasarea
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </Modal>
  );
}

export function Debts() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['debts', status], queryFn: () => api.get(`/debts?status=${status}`) });
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Registrul debitorilor</h1>
          <div className="sub">Titluri de creanță emise în urma constatării neregulilor (OUG 66/2011) și încasările lor.</div>
        </div>
        <a className="button" href={`/api/v1/debts?format=xlsx&status=${status}`}>
          Export Excel
        </a>
      </div>
      <ErrorAlert error={q.error} />
      {q.data && (
        <div className="kpis">
          <div className="kpi">
            <div className="v">{q.data.items.length}</div>
            <div className="l">titluri de creanță</div>
          </div>
          <div className="kpi">
            <div className="v">{fmtAmount(q.data.totals.principal)}</div>
            <div className="l">debite stabilite (lei)</div>
          </div>
          <div className="kpi">
            <div className="v">{fmtAmount(q.data.totals.paid)}</div>
            <div className="l">încasat (lei)</div>
          </div>
          <div className="kpi">
            <div className="v" style={{ color: 'var(--c-danger)' }}>{fmtAmount(q.data.totals.balance)}</div>
            <div className="l">sold de recuperat (lei)</div>
          </div>
        </div>
      )}
      <label className="row small">
        Stare
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Toate</option>
          {Object.entries(STATUS).map(([k, [l]]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <Card flush>
        {q.isLoading ? (
          <Loading />
        ) : !q.data?.items.length ? (
          <Empty>Nu există creanțe.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Titlu</th>
                  <th>Beneficiar</th>
                  <th className="num">Debit</th>
                  <th className="num">Încasat</th>
                  <th className="num">Sold</th>
                  <th>Scadență</th>
                  <th>Stare</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((d: any) => (
                  <tr key={d.id}>
                    <td>
                      <button className="link" onClick={() => setOpen(d.id)}>
                        {d.title_number}
                      </button>
                      <div className="small muted">{fmtDate(d.title_date)}</div>
                    </td>
                    <td>
                      {d.beneficiary_name}
                      <div className="small muted">SMIS {d.smis_code}</div>
                    </td>
                    <td className="num">{fmtAmount(d.principal)}</td>
                    <td className="num">{fmtAmount(d.paid)}</td>
                    <td className="num">
                      <strong>{fmtAmount(d.balance)}</strong>
                    </td>
                    <td className="nowrap">
                      {fmtDate(d.due_date)} {d.overdue && <Badge tone="red">restant</Badge>}
                    </td>
                    <td>
                      <Badge tone={STATUS[d.status]?.[1]}>{STATUS[d.status]?.[0] ?? d.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <DebtDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function Irregularities() {
  const q = useQuery({ queryKey: ['irregularities'], queryFn: () => api.get('/irregularities') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const reportable = q.data.items.filter((i: any) => i.ims_reportable);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Nereguli</h1>
          <div className="sub">
            Dosare de constatare (P4). Se raportează în IMS (OLAF) neregulile confirmate de cel puțin {q.data.thresholdEur.toLocaleString('ro-RO')} EUR (curs {q.data.eurRon} lei/EUR) și cele marcate manual.
          </div>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="v">{q.data.items.length}</div>
          <div className="l">dosare de nereguli</div>
        </div>
        <div className="kpi">
          <div className="v">{q.data.items.filter((i: any) => i.outcome === 'confirmata').length}</div>
          <div className="l">confirmate</div>
        </div>
        <div className="kpi">
          <div className="v" style={{ color: 'var(--c-danger)' }}>{reportable.length}</div>
          <div className="l">de raportat în IMS</div>
        </div>
      </div>
      <Card flush>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Dosar</th>
                <th>Beneficiar</th>
                <th>Tip</th>
                <th>Rezultat</th>
                <th className="num">Creanță (lei)</th>
                <th className="num">EUR</th>
                <th>IMS</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((i: any) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/dosare/${i.id}`}>{i.reference_no ?? i.title}</Link>
                    <div className="small muted">{fmtDate(i.started_at?.slice(0, 10))}</div>
                  </td>
                  <td>
                    {i.beneficiary_name}
                    <div className="small muted">SMIS {i.smis_code}</div>
                  </td>
                  <td>{i.irregularity_type ?? '—'}</td>
                  <td>{i.outcome === 'confirmata' ? <Badge tone="red">confirmată</Badge> : i.outcome === 'neconfirmata' ? <Badge tone="green">neconfirmată</Badge> : <Badge>în verificare</Badge>}</td>
                  <td className="num">{fmtAmount(i.debt_principal ?? i.affected_amount)}</td>
                  <td className="num">{i.amount_eur ? i.amount_eur.toLocaleString('ro-RO', { minimumFractionDigits: 2 }) : ''}</td>
                  <td>{i.ims_reportable ? <Badge tone="red">de raportat</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
