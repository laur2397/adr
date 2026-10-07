import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ErrorAlert } from '../components/ui';

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { username, password, totp: needTotp ? totp : undefined });
      onLoggedIn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        if (needTotp) setError(err);
        setNeedTotp(true);
      } else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="card">
        <header>
          <div>
            <div className="brandline">Flux AM</div>
            <div className="muted small">Management electronic al documentelor și fluxurilor</div>
          </div>
        </header>
        <form className="body" onSubmit={submit}>
          <h1 className="sr-only">Autentificare</h1>
          <ErrorAlert error={error} />
          {!needTotp ? (
            <>
              <label className="field">
                <span className="label">Utilizator</span>
                <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
              </label>
              <label className="field">
                <span className="label">Parolă</span>
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
            </>
          ) : (
            <label className="field">
              <span className="label">Codul din aplicația de autentificare</span>
              <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" value={totp} onChange={(e) => setTotp(e.target.value)} required autoFocus />
              <span className="field-hint">Codul de 6 cifre afișat în aplicația de pe telefon.</span>
            </label>
          )}
          <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Se verifică…' : needTotp ? 'Confirmă codul' : 'Intră în cont'}
          </button>
        </form>
      </section>
    </div>
  );
}
