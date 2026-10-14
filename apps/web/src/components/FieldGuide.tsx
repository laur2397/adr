/**
 * Guidance for the monitoring officer on site, from the study material "Vizita pe teren a ofițerului
 * de monitorizare" (PR Sud-Vest Oltenia 2021–2027): the S-A-E-V-F memo, what to do in the common
 * difficult situations, ethics and the legal deadlines. Static text, available without signal.
 */

const SAEVF: Array<[string, string, string]> = [
  ['S', 'Stadiul', 'Ce există fizic, față de grafic și de ultimul raport de progres. Raportul spune, vizita arată.'],
  ['A', 'Actele', 'Originalele: contracte, acte adiționale, facturi, PV de recepție, autorizația, jurnalul de șantier, pontajele.'],
  ['E', 'Echipamentele', 'Existență, serii față de facturi, amplasare, funcționare, inventar, etichete. Fiecare cu fotografie.'],
  ['V', 'Vizibilitatea', 'Afiș A3 / panou / plăcuță, după valoarea proiectului; emblema UE și mențiunea de cofinanțare.'],
  ['F', 'Finalul', 'Concluzii verbale fără promisiuni, punctul de vedere al beneficiarului, lista documentelor de încărcat în MySMIS.'],
];

const SITUATIONS: Array<[string, string]> = [
  [
    'Lucrările sunt mult în urma celor declarate (de ex. 70% raportat, 30% pe teren)',
    'Estimați procentul real, fotografiați din aceleași unghiuri ca la vizita anterioară, măsurați 2–3 poziții din situațiile de lucrări. Cereți explicația scrisă prin MySMIS. Întârzierea nu este, în sine, neregulă; decontarea unor lucrări neexecutate este.',
  ],
  [
    'Un echipament facturat lipsește',
    'Notați „Lipsă” în tabelul de echipamente, fotografiați locul în care ar trebui să fie, cereți explicația (în service, mutat, în altă locație). Nu acceptați fotografii de pe telefonul beneficiarului în locul echipamentului.',
  ],
  ['Pe șantier lucrează altă firmă decât cea contractată', 'Consemnați numele firmei, fotografiați utilajele și ecusoanele (nu persoanele), verificați dacă este subcontractant declarat. Dacă nu, semnalați ierarhic.'],
  ['Panoul lipsește sau este prea mic', 'Măsurați și fotografiați cu ruleta. Formulați o recomandare cu termen și dovadă (fotografie datată în MySMIS). Nerespectarea poate atrage o reducere de până la 3% din sprijin.'],
  ['Autorizația de construire a expirat sau lucrările o depășesc', 'Nu este o problemă de rezolvat pe loc: consemnați, fotografiați și semnalați ierarhic. Lucrările neautorizate nu sunt eligibile.'],
  [
    'Reprezentantul vă sugerează să „omiteți” ceva',
    'Refuzați politicos, consemnați obiectiv ce ați constatat și informați șeful ierarhic. Orice ofertă (cadouri, mese, transport) se refuză.',
  ],
  ['Originalele nu sunt disponibile', 'Notați documentele lipsă la „Documente de încărcat în MySMIS”, cu termen. Nu luați documente pe hârtie: corespondența oficială se face doar prin MySMIS.'],
  ['Constructorul a blocat șantierul pentru neplată', 'Consemnați situația și cauza declarată, fotografiați, verificați cererile de plată depuse. Este un risc de implementare (punctul 10), nu o neregulă în sine.'],
];

const ETHICS = [
  'Imparțialitate: declarația de conflict de interese o semnați în aplicație înainte de a prelua vizita.',
  'Fără cadouri, mese sau transport din partea beneficiarului.',
  'Confidențialitate: constatările se comunică doar prin raport, după aprobare.',
  'GDPR: fotografiați lucrările și echipamentele, nu persoanele.',
  'Siguranța pe șantier: echipament de protecție, însoțit de responsabilul tehnic.',
  'Nu faceți promisiuni privind rezultatul vizitei sau plăți.',
];

const DEADLINES: Array<[string, string]> = [
  ['3 – 30 – 10', 'Raport de progres la fiecare 3 luni, depus în 30 de zile; raportul de vizită în 10 zile lucrătoare.'],
  ['≥ 10 zile', 'Alerta MySMIS pentru indicatorii de etapă, cu cel puțin 10 zile calendaristice înainte de termen.'],
  ['5 + 5 zile lucrătoare', 'Dovezile indicatorului de etapă: încărcate de beneficiar în 5 zile, verificate de AM în 5 zile.'],
  ['5 ani', 'Durabilitatea investiției și păstrarea dosarului proiectului (de la 31 decembrie a anului ultimei plăți).'],
];

const ESCALATION: Array<[string, string]> = [
  ['1. Sprijin', 'notificare, act adițional, grafic revizuit'],
  ['2. Monitorizare consolidată', 'justificare scrisă, întâlniri tehnice și pe teren'],
  ['3. Măsuri corective', 'întreruperea termenului de plată, respingeri, penalități până la 5% după 3 indicatori de etapă consecutivi neîndepliniți din culpa beneficiarului, suspendare (nu la primul indicator)'],
  ['4. Reziliere', 'OUG 133/2021, art. 37–38'],
];

export function FieldGuide() {
  return (
    <>
      <section className="field-card">
        <h2>Pe scurt: S-A-E-V-F</h2>
        <ol className="saevf">
          {SAEVF.map(([l, t, d]) => (
            <li key={l}>
              <span className="saevf-letter" aria-hidden="true">
                {l}
              </span>
              <div>
                <strong>{t}</strong>
                <div className="small">{d}</div>
              </div>
            </li>
          ))}
        </ol>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Regula de aur: știți ce ar trebui să vedeți, ce a declarat beneficiarul și unde este riscul cel mai mare.
        </p>
      </section>
      <section className="field-card">
        <h2>Situații dificile</h2>
        {SITUATIONS.map(([q, a]) => (
          <details key={q} className="field-details">
            <summary>{q}</summary>
            <p className="small">{a}</p>
          </details>
        ))}
      </section>
      <section className="field-card">
        <h2>Etică</h2>
        <ul className="small" style={{ paddingLeft: '1.1rem', margin: 0 }}>
          {ETHICS.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>
      <section className="field-card">
        <h2>Termene</h2>
        <dl className="field-dl">
          {DEADLINES.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd className="small">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="field-card">
        <h2>Escaladare</h2>
        <p className="small muted">Întârziere ≠ neregulă ≠ fraudă: consemnați obiectiv și semnalați ierarhic.</p>
        <dl className="field-dl">
          {ESCALATION.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd className="small">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
