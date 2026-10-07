import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, Card, ErrorAlert, useMe } from '../components/ui';
import { ROLE_LABEL, fmtDateTime } from '../format';

export function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users') });
  const subs = useQuery({ queryKey: ['substitutions'], queryFn: () => api.get('/substitutions') });
  const password = useMutation({ mutationFn: (b: unknown) => api.post('/me/password', b) });
  const startTotp = useMutation({ mutationFn: () => api.post('/me/totp/setup'), onSuccess: setSetup });
  const confirmTotp = useMutation({
    mutationFn: () => api.post('/me/totp/confirm', { secret: setup!.secret, code }),
    onSuccess: () => qc.setQueryData(['me'], null),
  });
  const addSub = useMutation({ mutationFn: (b: unknown) => api.post('/substitutions', b), onSuccess: () => qc.invalidateQueries({ queryKey: ['substitutions'] }) });
  const endSub = useMutation({ mutationFn: (id: string) => api.del(`/substitutions/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['substitutions'] }) });

  const onPassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('newPassword') !== f.get('repeat')) return;
    password.mutate({ currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') });
  };
  const onSub = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    addSub.mutate({
      substituteUserId: f.get('substitute'),
      scope: f.get('scope'),
      validFrom: new Date(`${f.get('from')}T00:00:00`).toISOString(),
      validTo: new Date(`${f.get('to')}T23:59:59`).toISOString(),
    });
  };

  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <h1>Contul meu</h1>
      <Card title={me.fullName}>
        <p>
          {me.username} · {me.email}
        </p>
        <div className="row">
          {me.roles.map((r) => (
            <Badge key={r} tone="blue">
              {ROLE_LABEL[r] ?? r}
            </Badge>
          ))}
        </div>
      </Card>
      <Card title="Înlocuitor în concediu">
        <p className="small muted">Înlocuitorul vede și finalizează sarcinile dumneavoastră în perioada aleasă; acțiunile se înregistrează „în numele” dumneavoastră.</p>
        <ErrorAlert error={addSub.error ?? endSub.error} />
        <form onSubmit={onSub} className="form-grid">
          <label className="field">
            <span className="label">Înlocuitor</span>
            <select name="substitute" required>
              <option value="">— alegeți —</option>
              {users.data?.items.filter((u: any) => u.id !== me.id).map((u: any) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Drepturi</span>
            <select name="scope" defaultValue="tasks">
              <option value="tasks">Doar sarcinile mele</option>
              <option value="full">Drepturi complete (și rolurile mele)</option>
            </select>
          </label>
          <label className="field"><span className="label">De la</span><input type="date" name="from" required /></label>
          <label className="field"><span className="label">Până la</span><input type="date" name="to" required /></label>
          <div className="wide"><button type="submit" disabled={addSub.isPending}>Stabilește înlocuitorul</button></div>
        </form>
        {subs.data?.items.length > 0 && (
          <table className="data" style={{ marginTop: 12 }}>
            <thead><tr><th>Absent</th><th>Înlocuitor</th><th>Perioada</th><th>Drepturi</th><th /></tr></thead>
            <tbody>
              {subs.data.items.map((s: any) => (
                <tr key={s.id}>
                  <td>{s.absent_name}</td><td>{s.substitute_name}</td><td className="small">{fmtDateTime(s.valid_from)} – {fmtDateTime(s.valid_to)}</td>
                  <td>{s.scope === 'full' ? 'complete' : 'sarcini'}</td>
                  <td>{s.absent_user_id === me.id && <button className="small" onClick={() => endSub.mutate(s.id)}>Încheie</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Autentificare în doi pași (2FA)">
        {me.totpEnabled ? (
          <p><Badge tone="green">activă</Badge> La autentificare vi se cere și codul din aplicație.</p>
        ) : !setup ? (
          <>
            <p className="small">Folosiți o aplicație de autentificare (de ex. Microsoft Authenticator, Google Authenticator, FreeOTP).</p>
            <button onClick={() => startTotp.mutate()}>Activează 2FA</button>
          </>
        ) : (
          <>
            <ErrorAlert error={confirmTotp.error} />
            <p className="small">În aplicație alegeți „adaugă cont” → „introdu cheia manual” și scrieți cheia de mai jos (sau deschideți linkul pe telefon):</p>
            <p className="mono" style={{ fontSize: '1.05rem', letterSpacing: '0.08em', wordBreak: 'break-all' }}>{setup.secret.match(/.{1,4}/g)?.join(' ')}</p>
            <p className="small"><a href={setup.otpauthUrl}>Deschide în aplicația de autentificare</a></p>
            <label className="field" style={{ maxWidth: 240 }}>
              <span className="label">Codul afișat de aplicație</span>
              <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <button className="primary" onClick={() => confirmTotp.mutate()} disabled={confirmTotp.isPending}>Confirmă (va trebui să vă autentificați din nou)</button>
          </>
        )}
      </Card>
      <Card title="Schimbă parola">
        <ErrorAlert error={password.error} />
        {password.isSuccess && <div className="alert success small">Parola a fost schimbată.</div>}
        <form onSubmit={onPassword} className="form-grid">
          <label className="field"><span className="label">Parola curentă</span><input type="password" name="currentPassword" autoComplete="current-password" required /></label>
          <label className="field"><span className="label">Parola nouă</span><input type="password" name="newPassword" autoComplete="new-password" minLength={12} required /><span className="field-hint">Minim 12 caractere, litere și cifre.</span></label>
          <label className="field"><span className="label">Repetă parola nouă</span><input type="password" name="repeat" autoComplete="new-password" minLength={12} required /></label>
          <div className="wide"><button type="submit">Schimbă parola</button></div>
        </form>
      </Card>
    </div>
  );
}
