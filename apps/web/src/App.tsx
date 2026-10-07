import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router';
import { api, can, type Me } from './api';
import { Loading, MeContext } from './components/ui';
import { Account } from './pages/Account';
import { Admin } from './pages/Admin';
import { Dashboard } from './pages/Dashboard';
import { InstancePage } from './pages/Instance';
import { Instances } from './pages/Instances';
import { Login } from './pages/Login';
import { MyPanel } from './pages/MyPanel';
import { NewInstance } from './pages/NewInstance';
import { Registers } from './pages/Registers';
import { Archive } from './pages/Archive';
import { Debts, Irregularities } from './pages/Debts';
import { Mail } from './pages/Mail';
import { Sampling } from './pages/Sampling';
import { SearchPage } from './pages/Search';

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me'), retry: false, staleTime: 60_000 });

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener('flux:unauthorized', onUnauthorized);
    return () => window.removeEventListener('flux:unauthorized', onUnauthorized);
  }, [qc]);

  if (me.isLoading) return <Loading />;
  if (!me.data) return <Login onLoggedIn={() => qc.invalidateQueries()} />;
  return (
    <MeContext.Provider value={me.data}>
      <Layout me={me.data} />
    </MeContext.Provider>
  );
}

function Layout({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), refetchInterval: 60_000 });
  const logout = async () => {
    await api.post('/auth/logout');
    qc.clear();
    qc.setQueryData(['me'], null);
    navigate('/');
  };
  const unread = notifications.data?.unread ?? 0;
  const [q, setQ] = useState('');
  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Salt la conținut
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand">
          Flux AM
        </NavLink>
        <span className="org">{me.roles.includes('director') ? 'Vedere director: toate dosarele instituției' : 'Management electronic al documentelor și fluxurilor'}</span>
        <span className="spacer" />
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim().length >= 2) navigate(`/cautare?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <label htmlFor="global-search" className="sr-only">
            Caută în dosare și registre
          </label>
          <input
            id="global-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Caută dosare, beneficiari, facturi…"
            style={{ width: 260, padding: '0.3rem 0.6rem', border: '0', borderRadius: 6 }}
          />
        </form>
        <NavLink to="/cont" className="button small" style={{ color: '#fff', background: 'transparent', borderColor: 'rgb(255 255 255 / 35%)' }}>
          {me.fullName}
          {unread > 0 && <span className="badge red" aria-label={`${unread} notificări necitite`}>{unread}</span>}
        </NavLink>
        <button className="small" onClick={logout}>
          Ieșire
        </button>
      </header>
      <div className="shell">
        <nav className="sidenav" aria-label="Navigare principală">
          <div className="section">Lucru</div>
          <NavLink to="/" end>
            Panoul meu
          </NavLink>
          <NavLink to="/dosare">Dosare</NavLink>
          <NavLink to="/dosar-nou">Dosar nou</NavLink>
          {can.readRegisters(me) && <NavLink to="/registre">Registre</NavLink>}
          {can.register(me) && <NavLink to="/corespondenta">Corespondență e-mail</NavLink>}
          {(can.debts(me) || can.irregularities(me) || can.sampling(me) || can.archive(me)) && <div className="section">Control și evidențe</div>}
          {can.irregularities(me) && <NavLink to="/nereguli">Nereguli</NavLink>}
          {can.debts(me) && <NavLink to="/debitori">Debitori</NavLink>}
          {can.sampling(me) && <NavLink to="/esantionare">Eșantionare</NavLink>}
          {can.archive(me) && <NavLink to="/arhiva">Arhivă</NavLink>}
          {can.dashboard(me) && (
            <>
              <div className="section">Conducere</div>
              <NavLink to="/tablou">Tablou de bord</NavLink>
            </>
          )}
          {(can.admin(me) || can.audit(me) || can.validateLegal(me)) && (
            <>
              <div className="section">Administrare</div>
              <NavLink to="/admin">Administrare</NavLink>
            </>
          )}
          <div className="section">Cont</div>
          <NavLink to="/cont">Contul meu</NavLink>
        </nav>
        <main id="main" tabIndex={-1}>
          <Routes>
            <Route path="/" element={<MyPanel />} />
            <Route path="/dosare" element={<Instances />} />
            <Route path="/dosar-nou" element={<NewInstance />} />
            <Route path="/dosare/:id" element={<InstancePage />} />
            <Route path="/registre" element={<Registers />} />
            <Route path="/registre/:key" element={<Registers />} />
            <Route path="/tablou" element={<Dashboard />} />
            <Route path="/cautare" element={<SearchPage />} />
            <Route path="/debitori" element={<Debts />} />
            <Route path="/nereguli" element={<Irregularities />} />
            <Route path="/esantionare" element={<Sampling />} />
            <Route path="/arhiva" element={<Archive />} />
            <Route path="/corespondenta" element={<Mail />} />
            <Route path="/admin/*" element={<Admin />} />
            <Route path="/cont" element={<Account />} />
            <Route path="*" element={<p>Pagina nu există.</p>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
