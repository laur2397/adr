import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { api, can } from '../api';
import { Badge, Card, Empty, ErrorAlert, Loading, Modal, useMe } from '../components/ui';
import { ROLE_LABEL, fmtDate, fmtDateTime } from '../format';
import { ProcessDiagram } from '../components/ProcessDiagram';

function Users() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get('/admin/users') });
  const meta = useQuery({ queryKey: ['admin-meta'], queryFn: () => api.get('/admin/meta') });
  const [creating, setCreating] = useState(false);
  const [roleFor, setRoleFor] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const create = useMutation({ mutationFn: (b: unknown) => api.post('/admin/users', b), onSuccess: () => (setCreating(false), refresh()) });
  const addRole = useMutation({ mutationFn: (b: any) => api.post(`/admin/users/${roleFor.id}/roles`, b), onSuccess: () => (setRoleFor(null), refresh()) });
  const revoke = useMutation({ mutationFn: ({ u, a }: { u: string; a: string }) => api.del(`/admin/users/${u}/roles/${a}`), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (u: any) => api.patch(`/admin/users/${u.id}`, { active: !u.active }), onSuccess: refresh });
  const today = new Date().toISOString().slice(0, 10);

  const onCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    create.mutate({ ...f, departmentId: f.departmentId || undefined });
  };
  const onRole = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    addRole.mutate({ roleKey: f.roleKey, departmentId: f.departmentId || undefined, programId: f.programId || undefined, validFrom: f.validFrom || undefined, validTo: f.validTo || undefined });
  };
  if (users.isLoading) return <Loading />;
  return (
    <Card title="Utilizatori și roluri" actions={<button className="primary small" onClick={() => setCreating(true)}>Utilizator nou</button>} flush>
      <ErrorAlert error={users.error ?? revoke.error ?? toggle.error} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Nume</th>
              <th>Departament</th>
              <th>Roluri active</th>
              <th>2FA</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.items.map((u: any) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                <td>
                  {u.full_name}
                  <div className="muted small">
                    {u.username} · {u.email}
                  </div>
                </td>
                <td>{u.department ?? '—'}</td>
                <td>
                  {u.roles
                    .filter((r: any) => !r.valid_to || r.valid_to >= today)
                    .map((r: any) => (
                      <span key={r.id} className="row" style={{ gap: 4, display: 'inline-flex', marginRight: 6 }}>
                        <Badge tone="blue">{ROLE_LABEL[r.key] ?? r.name}</Badge>
                        {r.valid_to && <span className="small muted">până la {fmtDate(r.valid_to)}</span>}
                        <button className="link small" onClick={() => revoke.mutate({ u: u.id, a: r.id })} aria-label={`Retrage rolul ${r.name} pentru ${u.full_name}`}>
                          retrage
                        </button>
                      </span>
                    ))}
                </td>
                <td>{u.totp_enabled ? <Badge tone="green">activ</Badge> : <Badge>inactiv</Badge>}</td>
                <td className="right nowrap">
                  <button className="small" onClick={() => setRoleFor(u)}>
                    Adaugă rol
                  </button>{' '}
                  <button className="small" onClick={() => toggle.mutate(u)}>
                    {u.active ? 'Dezactivează' : 'Activează'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={creating} title="Utilizator nou" onClose={() => setCreating(false)}>
        <form onSubmit={onCreate}>
          <ErrorAlert error={create.error} />
          <label className="field"><span className="label">Nume complet</span><input name="fullName" required /></label>
          <label className="field"><span className="label">Utilizator</span><input name="username" required /></label>
          <label className="field"><span className="label">E-mail</span><input name="email" type="email" required /></label>
          <label className="field"><span className="label">Funcție</span><input name="jobTitle" /></label>
          <label className="field">
            <span className="label">Departament</span>
            <select name="departmentId">
              <option value="">—</option>
              {meta.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Parolă inițială</span>
            <input name="password" type="password" required minLength={12} autoComplete="new-password" />
            <span className="field-hint">Minim 12 caractere, litere și cifre.</span>
          </label>
          <button className="primary" type="submit" disabled={create.isPending}>Creează</button>
        </form>
      </Modal>
      <Modal open={Boolean(roleFor)} title={`Rol nou pentru ${roleFor?.full_name ?? ''}`} onClose={() => setRoleFor(null)}>
        <form onSubmit={onRole}>
          <ErrorAlert error={addRole.error} />
          <label className="field">
            <span className="label">Rol</span>
            <select name="roleKey" required>
              {meta.data?.roles.map((r: any) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Limitat la departamentul</span>
            <select name="departmentId">
              <option value="">— toată instituția —</option>
              {meta.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Limitat la programul</span>
            <select name="programId">
              <option value="">— toate programele —</option>
              {meta.data?.programs.map((p: any) => <option key={p.id} value={p.id}>{p.code} – {p.name}</option>)}
            </select>
          </label>
          <div className="form-grid">
            <label className="field"><span className="label">De la</span><input type="date" name="validFrom" /></label>
            <label className="field"><span className="label">Până la</span><input type="date" name="validTo" /></label>
          </div>
          <button className="primary" type="submit" disabled={addRole.isPending}>Atribuie</button>
        </form>
      </Modal>
    </Card>
  );
}

function Deadlines() {
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deadline-defs'], queryFn: () => api.get('/admin/deadline-definitions') });
  const [edit, setEdit] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['deadline-defs'] });
  const save = useMutation({ mutationFn: (b: any) => api.patch(`/admin/deadline-definitions/${edit.key}`, b), onSuccess: () => (setEdit(null), refresh()) });
  const validate = useMutation({ mutationFn: (key: string) => api.post(`/admin/deadline-definitions/${key}/validate`), onSuccess: refresh });
  const num = (v: FormDataEntryValue | null) => (v === '' || v === null ? null : Number(v));
  const onSave = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    save.mutate({
      name: f.get('name'), day_type: f.get('day_type'), days: num(f.get('days')), pause_mode: f.get('pause_mode'), start_point: f.get('start_point'),
      max_pauses: num(f.get('max_pauses')), max_paused_days: num(f.get('max_paused_days')), extension_days: num(f.get('extension_days')),
      warn_before_days: num(f.get('warn_before_days')), legal_reference: f.get('legal_reference'),
    });
  };
  if (q.isLoading) return <Loading />;
  return (
    <Card title="Termene" flush>
      <div className="alert warning" style={{ margin: '1rem' }}>
        Termenele legale sunt configurații. Orice modificare readuce termenul la starea „de validat juridic” până la confirmarea consilierului juridic.
      </div>
      <ErrorAlert error={validate.error} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>Termen</th><th>Regulă</th><th>Suspendări</th><th>Temei</th><th>Stare</th><th /></tr>
          </thead>
          <tbody>
            {q.data.items.map((d: any) => (
              <tr key={d.key}>
                <td>{d.name}<div className="muted small mono">{d.key}</div></td>
                <td>{d.days} zile {d.day_type === 'working' ? 'lucrătoare' : 'calendaristice'}{d.extension_days ? ` (+${d.extension_days} prelungire)` : ''}<div className="muted small">de la: {d.start_point}</div></td>
                <td>{d.pause_mode === 'suspend' ? 'suspendare' : 'întrerupere'}{d.max_pauses ? `, max ${d.max_pauses}` : ''}{d.max_paused_days ? `, max ${d.max_paused_days} zile` : ''}</td>
                <td className="small">{d.legal_reference}</td>
                <td>
                  {d.legal_status === 'validated' ? <Badge tone="green">validat</Badge> : <Badge tone="yellow">de validat juridic</Badge>}
                  {d.validated_by_name && <div className="muted small">{d.validated_by_name}, {fmtDate(d.validated_at?.slice(0, 10))}</div>}
                </td>
                <td className="right nowrap">
                  {can.admin(me) && <button className="small" onClick={() => setEdit(d)}>Modifică</button>}{' '}
                  {can.validateLegal(me) && d.legal_status !== 'validated' && <button className="small primary" onClick={() => validate.mutate(d.key)}>Validează</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={Boolean(edit)} title={`Modifică: ${edit?.name ?? ''}`} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={onSave}>
            <ErrorAlert error={save.error} />
            <label className="field"><span className="label">Denumire</span><input name="name" defaultValue={edit.name} required /></label>
            <div className="form-grid">
              <label className="field"><span className="label">Zile</span><input name="days" type="number" min={1} defaultValue={edit.days} required /></label>
              <label className="field"><span className="label">Tip zile</span><select name="day_type" defaultValue={edit.day_type}><option value="working">lucrătoare</option><option value="calendar">calendaristice</option></select></label>
              <label className="field"><span className="label">Pornește de la</span><select name="start_point" defaultValue={edit.start_point}><option value="submission_date">data depunerii</option><option value="registration_date">data înregistrării</option><option value="step_entry">intrarea în pas</option></select></label>
              <label className="field"><span className="label">La clarificări</span><select name="pause_mode" defaultValue={edit.pause_mode}><option value="suspend">se suspendă (se reia de unde a rămas)</option><option value="restart">se întrerupe (reîncepe)</option></select></label>
              <label className="field"><span className="label">Număr maxim de suspendări</span><input name="max_pauses" type="number" min={0} defaultValue={edit.max_pauses ?? ''} /></label>
              <label className="field"><span className="label">Maxim zile suspendate</span><input name="max_paused_days" type="number" min={0} defaultValue={edit.max_paused_days ?? ''} /></label>
              <label className="field"><span className="label">Prelungire (zile)</span><input name="extension_days" type="number" min={0} defaultValue={edit.extension_days ?? ''} /></label>
              <label className="field"><span className="label">Avertizare cu (zile)</span><input name="warn_before_days" type="number" min={0} defaultValue={edit.warn_before_days} /></label>
            </div>
            <label className="field"><span className="label">Temei legal</span><input name="legal_reference" defaultValue={edit.legal_reference ?? ''} /></label>
            <button className="primary" type="submit" disabled={save.isPending}>Salvează</button>
          </form>
        )}
      </Modal>
    </Card>
  );
}

function Calendar() {
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());
  const q = useQuery({ queryKey: ['calendar', year], queryFn: () => api.get(`/admin/calendar/${year}`) });
  const save = useMutation({ mutationFn: (b: unknown) => api.put(`/admin/calendar/${year}`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['calendar', year] }) });
  const [text, setText] = useState<string | null>(null);
  const holidays = q.data ? (q.data.holidays.length ? q.data.holidays : q.data.proposal ?? []) : [];
  const current: string = text ?? holidays.map((h: any) => `${h.day} ${h.name}`).join("\n");
  return (
    <Card title="Calendar zile lucrătoare" actions={<label className="row small">An <input type="number" value={year} onChange={(e) => { setYear(Number(e.target.value)); setText(null); }} style={{ width: 90 }} /></label>}>
      <ErrorAlert error={save.error} />
      {save.isSuccess && <div className="alert success small">Calendarul a fost salvat; termenele în curs au fost recalculate.</div>}
      {q.data && !q.data.holidays.length && <div className="alert warning small">Pentru {year} nu există încă sărbători salvate. Mai jos este propunerea calculată (Codul muncii, art. 139); verificați-o și salvați.</div>}
      <label className="field">
        <span className="label">Sărbători legale (o linie: AAAA-LL-ZZ denumire)</span>
        <textarea style={{ minHeight: 320 }} className="mono" value={current} onChange={(e) => setText(e.target.value)} />
      </label>
      <button
        className="primary"
        onClick={() =>
          save.mutate({
            holidays: current.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ day: l.slice(0, 10), name: l.slice(11).trim() || 'Sărbătoare legală' })),
            exceptions: q.data?.exceptions?.map((e: any) => ({ day: e.day, isWorking: e.is_working, note: e.note })) ?? [],
          })
        }
      >
        Salvează calendarul {year}
      </button>
    </Card>
  );
}

function Processes() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin-defs'], queryFn: () => api.get('/admin/process-definitions') });
  const [selected, setSelected] = useState<any>(null);
  const [json, setJson] = useState('');
  const [problems, setProblems] = useState<any[] | null>(null);
  const open = async (d: any) => {
    const full = await api.get(`/admin/process-definitions/${d.key}/versions/${d.version}`);
    setSelected(full);
    setJson(JSON.stringify(full.definition, null, 2));
    setProblems(null);
  };
  const parse = () => {
    try {
      return JSON.parse(json);
    } catch (e) {
      setProblems([{ path: '/', message: `JSON invalid: ${(e as Error).message}` }]);
      return null;
    }
  };
  const validate = useMutation({ mutationFn: (d: unknown) => api.post('/admin/process-definitions/validate', d), onSuccess: (r: any) => setProblems(r.problems) });
  const saveDraft = useMutation({
    mutationFn: async (d: any) => (selected.status === 'draft' ? api.put(`/admin/process-definitions/${d.key}/versions/${selected.version}`, { definition: d }) : api.post('/admin/process-definitions', { definition: d })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-defs'] }),
  });
  const publish = useMutation({ mutationFn: (d: any) => api.post(`/admin/process-definitions/${d.key}/versions/${d.version}/publish`), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-defs'] }) });
  if (list.isLoading) return <Loading />;
  return (
    <div className="stack">
      <Card title="Definiții de proces" flush>
        <table className="data">
          <thead><tr><th>Proces</th><th>Versiune</th><th>Stare</th><th>Publicat</th><th /></tr></thead>
          <tbody>
            {list.data.items.map((d: any) => (
              <tr key={d.id}>
                <td>{d.name}<div className="muted small mono">{d.key}</div></td>
                <td>v{d.version}</td>
                <td><Badge tone={d.status === 'published' ? 'green' : d.status === 'draft' ? 'yellow' : 'gray'}>{d.status === 'published' ? 'publicată' : d.status === 'draft' ? 'ciornă' : 'retrasă'}</Badge></td>
                <td>{fmtDateTime(d.published_at)}</td>
                <td className="right nowrap">
                  <button className="small" onClick={() => open(d)}>Deschide</button>{' '}
                  {d.status === 'draft' && <button className="small primary" onClick={() => publish.mutate(d)}>Publică</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <ErrorAlert error={publish.error} />
      {selected && (
        <Card title={`${selected.name} v${selected.version}`} actions={<>
          <button className="small" onClick={() => { const d = parse(); if (d) validate.mutate(d); }}>Validează</button>
          <button className="small primary" onClick={() => { const d = parse(); if (d) saveDraft.mutate(d); }}>{selected.status === 'draft' ? 'Salvează ciorna' : 'Salvează ca versiune nouă (ciornă)'}</button>
        </>}>
          <p className="small muted">Versiunile publicate nu se modifică; dosarele în curs rămân pe versiunea cu care au pornit. Editorul vizual este planificat pentru faza 2.</p>
          <ErrorAlert error={saveDraft.error} />
          {saveDraft.isSuccess && <div className="alert success small">Ciorna a fost salvată. Publicați-o din listă.</div>}
          {problems && (problems.length ? (
            <div className="alert error"><strong>Probleme găsite:</strong><ul>{problems.map((p, i) => <li key={i}><span className="mono">{p.path}</span> {p.message}</li>)}</ul></div>
          ) : <div className="alert success small">Definiția este validă.</div>)}
          {(() => {
            try {
              const parsed = JSON.parse(json);
              return Array.isArray(parsed.steps) ? <div style={{ marginBottom: 12 }}><ProcessDiagram steps={parsed.steps} /></div> : null;
            } catch {
              return null;
            }
          })()}
          <label className="sr-only" htmlFor="def-json">Definiție JSON</label>
          <textarea id="def-json" className="mono" style={{ minHeight: 480, fontSize: 13 }} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
        </Card>
      )}
    </div>
  );
}

function Checklists() {
  const q = useQuery({ queryKey: ['admin-checklists'], queryFn: () => api.get('/admin/checklist-templates') });
  if (q.isLoading) return <Loading />;
  return (
    <div className="stack">
      {q.data.items.map((t: any) => (
        <Card key={t.id} title={`${t.name} (v${t.version})`} actions={<Badge tone={t.status === 'published' ? 'green' : 'gray'}>{t.status}</Badge>} flush>
          <table className="data">
            <thead><tr><th>Nr.</th><th>Întrebare</th><th>Temei</th><th>Observații obligatorii la</th></tr></thead>
            <tbody>
              {t.items.map((i: any) => (
                <tr key={i.code}><td>{i.code}</td><td>{i.question}</td><td className="small">{i.legal_basis ?? ''}</td><td className="small">{i.observation_required_on.join(', ')}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function Templates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-templates'], queryFn: () => api.get('/admin/document-templates') });
  const upload = useMutation({ mutationFn: (fd: FormData) => api.post('/admin/document-templates', fd), onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-templates'] }) });
  return (
    <div className="stack">
      <Card title="Șabloane de documente" flush>
        {q.isLoading ? <Loading /> : (
          <table className="data">
            <thead><tr><th>Șablon</th><th>Versiune</th><th>Stare</th><th>SHA-256</th></tr></thead>
            <tbody>
              {q.data.items.map((t: any) => (
                <tr key={t.id}><td>{t.name}<div className="muted small mono">{t.key}</div></td><td>v{t.version}</td><td><Badge tone={t.status === 'published' ? 'green' : 'gray'}>{t.status}</Badge></td><td className="mono small">{t.sha256.slice(0, 16)}…</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Încarcă o versiune nouă">
        <ErrorAlert error={upload.error} />
        {upload.isSuccess && <div className="alert success small">Șablonul a fost încărcat.</div>}
        <form onSubmit={(e) => { e.preventDefault(); upload.mutate(new FormData(e.currentTarget)); }} className="form-grid">
          <label className="field"><span className="label">Cheie (ex. p1_verification_note)</span><input name="key" required /></label>
          <label className="field"><span className="label">Denumire</span><input name="name" required /></label>
          <label className="field"><span className="label">Fișier DOCX</span><input type="file" name="file" accept=".docx" required /></label>
          <label className="row field"><input type="checkbox" name="publish" value="true" /> Publică imediat</label>
          <div className="wide">
            <p className="small muted">Etichete disponibile: câmpurile procesului ({'{request_no}'}, {'{total_eligible}'} …), {'{beneficiary.name}'}, {'{project.smis_code}'}, {'{organization.name}'}, {'{today}'}, {'{registration_in}'}, tabele cu {'{#expenses}…{/expenses}'} și {'{#checklist}…{/checklist}'}.</p>
            <button type="submit" disabled={upload.isPending}>Încarcă</button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function ImportProjects() {
  const imp = useMutation({ mutationFn: (fd: FormData) => api.post('/projects/import', fd) });
  return (
    <Card title="Import proiecte și contracte (XLSX)">
      <p className="small">Foaia <strong>Proiecte</strong>: cod_smis, titlu, cui_beneficiar, program, nr_contract, data_contract, valoare_totala, valoare_eligibila, valoare_nerambursabila, data_inceput, data_sfarsit, expert_responsabil. Foaia <strong>Linii bugetare</strong>: cod_smis, cod_linie, categorie, suma_eligibila, suma_neeligibila. Prima linie este antetul. Beneficiarii noi se completează automat din ANAF.</p>
      <ErrorAlert error={imp.error} />
      <form onSubmit={(e) => { e.preventDefault(); imp.mutate(new FormData(e.currentTarget)); }} className="row">
        <input type="file" name="file" accept=".xlsx" required style={{ maxWidth: 360 }} />
        <button className="primary" type="submit" disabled={imp.isPending}>{imp.isPending ? 'Se importă…' : 'Importă'}</button>
      </form>
      {imp.data && (
        <table className="data" style={{ marginTop: 12 }}>
          <thead><tr><th>Foaie</th><th>Rând</th><th>Rezultat</th></tr></thead>
          <tbody>
            {imp.data.report.map((r: any, i: number) => (
              <tr key={i}><td>{r.sheet}</td><td>{r.row}</td><td>{r.status === 'ok' ? <Badge tone="green">ok</Badge> : <Badge tone="red">eroare</Badge>} {r.message}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Audit() {
  const verify = useMutation({ mutationFn: () => api.get('/admin/audit/verify') });
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['admin-audit', filter], queryFn: () => api.get(`/admin/audit?action=${encodeURIComponent(filter)}`) });
  return (
    <div className="stack">
      <Card title="Integritatea jurnalului de audit" actions={<button className="primary small" onClick={() => verify.mutate()}>Verifică lanțul</button>}>
        <ErrorAlert error={verify.error} />
        {verify.data ? (
          verify.data.intact ? (
            <div className="alert success">Lanțul de hash-uri este intact: {verify.data.events} evenimente, ultimul hash <span className="mono">{verify.data.last_hash?.slice(0, 24)}…</span></div>
          ) : (
            <div className="alert error">Lanțul este rupt la evenimentul #{verify.data.brokenAt}. Anunțați responsabilul de securitate.</div>
          )
        ) : (
          <p className="muted small">Fiecare eveniment conține hash-ul celui anterior; orice modificare a unui rând rupe lanțul.</p>
        )}
      </Card>
      <Card title="Evenimente recente" actions={<input placeholder="filtru acțiune, ex. document." value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 240 }} aria-label="Filtru acțiune" />} flush>
        {q.isLoading ? <Loading /> : q.error ? <ErrorAlert error={q.error} /> : !q.data.items.length ? <Empty>Nimic.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Moment</th><th>Cine</th><th>Acțiune</th><th>Entitate</th></tr></thead>
              <tbody>
                {q.data.items.map((e: any) => (
                  <tr key={e.id}><td className="mono">{e.id}</td><td className="nowrap">{fmtDateTime(e.occurred_at)}</td><td>{e.actor ?? 'sistem'}{e.on_behalf_of && <div className="muted small">în numele: {e.on_behalf_of}</div>}</td><td className="mono">{e.action}</td><td className="mono small">{e.entity_type}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Integrations() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get('/admin/api-tokens') });
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get('/admin/webhooks') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users') });
  const [secret, setSecret] = useState<string | null>(null);
  const createToken = useMutation({ mutationFn: (b: unknown) => api.post('/admin/api-tokens', b), onSuccess: (r: any) => (setSecret(`Token: ${r.token}`), qc.invalidateQueries({ queryKey: ['api-tokens'] })) });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/admin/api-tokens/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }) });
  const createHook = useMutation({ mutationFn: (b: unknown) => api.post('/admin/webhooks', b), onSuccess: (r: any) => (setSecret(`Secret webhook (pentru verificarea semnăturii HMAC): ${r.secret}`), qc.invalidateQueries({ queryKey: ['webhooks'] })) });
  const toggle = useMutation({ mutationFn: (h: any) => api.patch(`/admin/webhooks/${h.id}`, { active: !h.active }), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  return (
    <div className="stack">
      {secret && (
        <div className="alert warning">
          <strong>Copiați acum valoarea de mai jos; nu va mai fi afișată.</strong>
          <div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>{secret}</div>
        </div>
      )}
      <ErrorAlert error={createToken.error ?? createHook.error ?? revoke.error} />
      <Card title="Tokenuri API (Power BI, alte sisteme)" flush>
        <form
          className="form-grid"
          style={{ padding: '1rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            createToken.mutate({ name: f.name, userId: f.userId, expiresAt: f.expiresAt || undefined });
          }}
        >
          <label className="field"><span className="label">Nume</span><input name="name" required placeholder="ex. Power BI conducere" /></label>
          <label className="field">
            <span className="label">Acționează ca utilizatorul</span>
            <select name="userId" required>
              {users.data?.items.map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
          </label>
          <label className="field"><span className="label">Expiră la</span><input type="date" name="expiresAt" /></label>
          <div className="wide"><button type="submit">Generează token</button> <span className="small muted">Folosire: antetul <span className="mono">Authorization: Bearer flx_…</span>; documentația la <a href="/api/docs" target="_blank" rel="noopener">/api/docs</a>.</span></div>
        </form>
        <table className="data">
          <thead><tr><th>Nume</th><th>Acționează ca</th><th>Ultima folosire</th><th>Stare</th><th /></tr></thead>
          <tbody>
            {tokens.data?.items.map((t: any) => (
              <tr key={t.id}>
                <td>{t.name}<div className="small muted">creat de {t.created_by_name}, {fmtDateTime(t.created_at)}</div></td>
                <td>{t.acts_as}</td>
                <td>{fmtDateTime(t.last_used_at) || '—'}</td>
                <td>{t.revoked_at ? <Badge>revocat</Badge> : <Badge tone="green">activ</Badge>}</td>
                <td>{!t.revoked_at && <button className="small danger" onClick={() => revoke.mutate(t.id)}>Revocă</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Webhook-uri (notificări către alte sisteme)" flush>
        <form
          className="form-grid"
          style={{ padding: '1rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            createHook.mutate({ name: fd.get('name'), url: fd.get('url'), events: fd.getAll('events') });
          }}
        >
          <label className="field"><span className="label">Nume</span><input name="name" required /></label>
          <label className="field"><span className="label">Adresă (URL)</span><input name="url" required placeholder="https://…" /></label>
          <fieldset className="wide" style={{ border: 0, padding: 0 }}>
            <legend className="field-label">Evenimente</legend>
            <div className="row">
              {hooks.data?.events.map((ev: string) => (
                <label key={ev} className="row small"><input type="checkbox" name="events" value={ev} /> <span className="mono">{ev}</span></label>
              ))}
            </div>
          </fieldset>
          <div className="wide"><button type="submit">Adaugă webhook</button></div>
        </form>
        <table className="data">
          <thead><tr><th>Nume</th><th>Evenimente</th><th className="num">Livrate / eșuate</th><th>Stare</th></tr></thead>
          <tbody>
            {hooks.data?.items.map((h: any) => (
              <tr key={h.id}>
                <td>{h.name}<div className="small muted mono">{h.url}</div></td>
                <td className="small mono">{h.events.join(', ')}</td>
                <td className="num">{h.delivered} / {h.failed}</td>
                <td><button className="small" onClick={() => toggle.mutate(h)}>{h.active ? 'Activ – oprește' : 'Oprit – pornește'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function Admin() {
  const me = useMe();
  const items: Array<[string, string, boolean]> = [
    ['', 'Utilizatori', can.admin(me)],
    ['termene', 'Termene', can.admin(me) || can.validateLegal(me)],
    ['calendar', 'Calendar', can.admin(me)],
    ['procese', 'Procese', can.admin(me)],
    ['liste', 'Liste de verificare', can.admin(me)],
    ['sabloane', 'Șabloane', can.admin(me)],
    ['import', 'Import proiecte', can.admin(me)],
    ['integrari', 'Integrări', can.integrations(me)],
    ['audit', 'Audit', me.roles.some((r) => ['auditor', 'functional_admin'].includes(r))],
  ];
  const visible = items.filter(([, , show]) => show);
  return (
    <div className="stack">
      <h1>Administrare</h1>
      <nav className="tabs" aria-label="Secțiuni administrare">
        {visible.map(([path, label]) => (
          <NavLink key={path} to={`/admin/${path}`} end className={({ isActive }) => (isActive ? 'button small primary' : 'button small')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={can.admin(me) ? <Users /> : visible[0]?.[0] === 'termene' ? <Deadlines /> : <Audit />} />
        <Route path="termene" element={<Deadlines />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="procese" element={<Processes />} />
        <Route path="liste" element={<Checklists />} />
        <Route path="sabloane" element={<Templates />} />
        <Route path="import" element={<ImportProjects />} />
        <Route path="audit" element={<Audit />} />
        <Route path="integrari" element={<Integrations />} />
      </Routes>
    </div>
  );
}
