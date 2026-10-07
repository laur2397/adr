import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { api, ApiError, can, type Me } from './api';
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
import { FieldVisit } from './pages/FieldVisit';
import { Visits } from './pages/Visits';

const ME_KEY = 'flux.me';

/** The current user; without signal the last known one is used, so the field page opens offline. */
async function loadMe(): Promise<Me | null> {
  try {
    const me = await api.get<Me>('/me');
    try {
      localStorage.setItem(ME_KEY, JSON.stringify(me));
    } catch {
      /* storage full or disabled */
    }
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      const cached = localStorage.getItem(ME_KEY);
      if (cached) return JSON.parse(cached) as Me;
    }
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      /* storage disabled */
    }
    throw err;
  }
}

export function App() {
  const qc = useQueryClient();
  const location = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: loadMe, retry: false, staleTime: 60_000 });

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener('flux:unauthorized', onUnauthorized);
    return () => window.removeEventListener('flux:unauthorized', onUnauthorized);
  }, [qc]);

  if (me.isLoading) return <Loading />;
  if (!me.data) return <Login onLoggedIn={() => qc.invalidateQueries()} />;
  return (
    <MeContext.Provider value={me.data}>
      {location.pathname.startsWith('/teren/') ? (
        <Routes>
          <Route path="/teren/:id" element={<FieldVisit />} />
        </Routes>
      ) : (
        <Layout me={me.data} />
      )}
    </MeContext.Provider>
  );
}

function Layout({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), refetchInterval: 60_000 });
  const logout = async () => {
    await api.post('/auth/logout');
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      /* storage disabled */
    }
    qc.clear();
    qc.setQueryData(['me'], null);
    navigate('/');
  };
  const unread = notifications.data?.unread ?? 0;
  const [q, setQ] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();
  const pending = useQuery({ queryKey: ['signatures-pending'], queryFn: () => api.get('/signatures/pending'), refetchInterval: 120_000 });
  const toSign = pending.data?.items?.length ?? 0;
  // Navigating closes the phone menu and search.
  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [location.pathname, location.search]);
  const initials = me.fullName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className={`app${menuOpen ? ' menu-open' : ''}`}>
      <a href="#main" className="skip-link">
        Salt la conținut
      </a>
      <header className="topbar">
        <button className="icon-btn only-mobile" aria-label="Meniu" aria-expanded={menuOpen} aria-controls="main-nav" onClick={() => setMenuOpen((o) => !o)}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <NavLink to="/" className="brand">
          Flux AM
        </NavLink>
        <span className="org">{me.roles.includes('director') ? 'Vedere director: toate dosarele instituției' : 'Management electronic al documentelor și fluxurilor'}</span>
        <span className="spacer" />
        <form
          role="search"
          className={`topsearch${searchOpen ? ' open' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim().length >= 2) navigate(`/cautare?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <label htmlFor="global-search" className="sr-only">
            Caută în dosare și registre
          </label>
          <input id="global-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Caută dosare, beneficiari, facturi…" />
        </form>
        <button className="icon-btn only-mobile" aria-label="Caută" aria-expanded={searchOpen} onClick={() => setSearchOpen((o) => !o)}>
          <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <NavLink to="/cont" className="button small userbtn" aria-label={`Contul meu: ${me.fullName}${unread ? `, ${unread} notificări necitite` : ''}`}>
          <span className="only-desktop">{me.fullName}</span>
          <span className="avatar mobile-avatar" aria-hidden="true">
            {initials}
          </span>
          {unread > 0 && <span className="badge red" aria-hidden="true">{unread}</span>}
        </NavLink>
        <button className="small only-desktop" onClick={logout}>
          Ieșire
        </button>
      </header>
      {menuOpen && <div className="nav-backdrop only-mobile" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <div className="shell">
        <nav className="sidenav" id="main-nav" aria-label="Navigare principală">
          <div className="section">Lucru</div>
          <NavLink to="/" end>
            Panoul meu
          </NavLink>
          <NavLink to="/dosare">Dosare</NavLink>
          <NavLink to="/dosar-nou">Dosar nou</NavLink>
          {can.readRegisters(me) && <NavLink to="/registre">Registre</NavLink>}
          {can.register(me) && <NavLink to="/corespondenta">Corespondență e-mail</NavLink>}
          {(can.debts(me) || can.irregularities(me) || can.sampling(me) || can.archive(me) || can.visits(me)) && <div className="section">Control și evidențe</div>}
          {can.irregularities(me) && <NavLink to="/nereguli">Nereguli</NavLink>}
          {can.debts(me) && <NavLink to="/debitori">Debitori</NavLink>}
          {can.sampling(me) && <NavLink to="/esantionare">Eșantionare</NavLink>}
          {can.visits(me) && <NavLink to="/vizite">Vizite pe teren</NavLink>}
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
          <button className="link only-mobile sidenav-logout" onClick={logout}>
            Ieșire din cont
          </button>
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
            <Route path="/vizite" element={<Visits />} />
            <Route path="/arhiva" element={<Archive />} />
            <Route path="/corespondenta" element={<Mail />} />
            <Route path="/admin/*" element={<Admin />} />
            <Route path="/cont" element={<Account />} />
            <Route path="*" element={<p>Pagina nu există.</p>} />
          </Routes>
        </main>
      </div>
      <nav className="bottomnav only-mobile" aria-label="Navigare rapidă">
        <NavLink to="/" end>
          <span aria-hidden="true">⌂</span>Panou
          {toSign > 0 && <span className="badge red">{toSign}</span>}
        </NavLink>
        <NavLink to="/dosare">
          <span aria-hidden="true">▤</span>Dosare
        </NavLink>
        {can.dashboard(me) ? (
          <NavLink to="/tablou">
            <span aria-hidden="true">▦</span>Tablou
          </NavLink>
        ) : (
          <NavLink to="/dosar-nou">
            <span aria-hidden="true">＋</span>Dosar nou
          </NavLink>
        )}
        {can.visits(me) && (
          <NavLink to="/vizite">
            <span aria-hidden="true">⚑</span>Vizite
          </NavLink>
        )}
        <button type="button" onClick={() => setMenuOpen(true)} aria-controls="main-nav" aria-expanded={menuOpen}>
          <span aria-hidden="true">☰</span>Meniu
        </button>
      </nav>
    </div>
  );
}
