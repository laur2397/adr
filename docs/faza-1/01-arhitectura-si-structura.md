# Flux AM – Faza 1: arhitectura si structura proiectului

## 1. Decizii principale

| Decizie | Alegere | Motiv |
|---|---|---|
| Forma aplicatiei | **monolit modular** (un API, module cu granite clare) + worker pentru joburi | o echipa de 3-4 oameni, instalare on-premise simpla; modulele pot fi separate ulterior |
| Backend | **TypeScript, NestJS**, Node 22 LTS | aceeasi limba cu frontend-ul si cu schema definitiilor de proces (tipuri partajate) |
| Baza de date | **PostgreSQL 16** | tranzactii pentru contoare, JSONB pentru valori de formular, full-text, triggere pentru audit |
| Acces la date | **Kysely** (query builder tipizat) + migrari SQL scrise de mana | controlam exact SQL-ul pentru contoare, blocari si audit; schema este [`db/schema.sql`](../../db/schema.sql) |
| Motor de flux | **propriu**, definitii JSON validate cu JSON Schema | semantica necesara (matrice camp x pas, termene cu suspendari, invalidarea semnaturilor la returnare, inlocuiri) e specifica produsului; Flowable ar aduce un runtime Java si un al doilea model de date fara sa rezolve aceste parti. Pastram un `WorkflowEngine` ca interfata, deci un adaptor Flowable ramane posibil |
| Coada de joburi | **pg-boss** (pe PostgreSQL, MIT) | fara Redis: o componenta mai putin de instalat si de salvat; volumul (termene, email, generare documente) este mic |
| Fisiere | **interfata `ObjectStorage`**, implementari: sistem de fisiere si S3 (SeaweedFS in docker-compose) | vezi sectiunea 3 despre MinIO |
| Documente | **docxtemplater** (MIT, modulele de baza) pentru DOCX; **LibreOffice headless** (MPL) intr-un container separat pentru PDF | prompt, sectiunea 13 |
| Semnatura | adaptor `SignatureProvider` (un furnizor in Faza 1); validare cu **EU DSS** ca serviciu separat | PAdES B-LTA si validarea nu au biblioteci mature in Node |
| Frontend | **React + TypeScript**, Vite, React Router, TanStack Query, react-hook-form, componente accesibile (React Aria) | WCAG 2.1 AA |
| Autentificare | sesiuni server-side (cookie HttpOnly) + parola argon2id + TOTP; OIDC optional | un portal intern; revocare imediata a sesiunii |
| Observabilitate | loguri JSON (pino), metrici Prometheus, `/health` si `/ready` | prompt, sectiunea 13 |

## 2. Structura repository-ului

```
flux-am/
├── apps/
│   ├── api/                      # NestJS: REST API + OpenAPI
│   │   └── src/
│   │       ├── identity/         # utilizatori, roluri, inlocuiri, sesiuni, 2FA
│   │       ├── access/           # politica de acces pe proces/pas/instanta/camp
│   │       ├── audit/            # scriere in jurnal, verificarea lantului
│   │       ├── reference/        # programe, apeluri, beneficiari, proiecte, nomenclatoare
│   │       ├── workflow/         # Modulul 1: definitii, instante, sarcini, tranzitii
│   │       ├── forms/            # Modulul 2: campuri, liste de articole, validari, precompletare
│   │       ├── checklists/       # liste de verificare si raspunsuri
│   │       ├── documents/        # fisiere, versiuni, sabloane, generare
│   │       ├── registry/         # Modulul 3: registre, inregistrari, emitenti, clasare
│   │       ├── deadlines/        # Modulul 4: calendar, termene, suspendari, escaladari
│   │       ├── signing/          # Modulul 5: cereri de semnare, adaptoare, validare
│   │       ├── integrations/
│   │       │   └── anaf/         # interogare dupa CUI
│   │       ├── reporting/        # tablou de bord, exporturi XLSX, vederi pentru Power BI
│   │       └── packages/         # P1, P2, P5: definitii, sabloane, liste, automatizari specifice
│   └── worker/                   # pg-boss: termene, reamintiri, generare PDF, email
│   └── web/                      # React: Panoul meu, Dosare, Dosarul, Registre, Tablou, Administrare
├── packages/
│   ├── process-schema/           # JSON Schema pentru definitii de proces + tipuri TS generate
│   ├── working-days/             # calcul zile lucratoare si termene (fara dependente, testat separat)
│   ├── validators/               # CUI, IBAN, cod SMIS, sume RON – folosite si in API si in UI
│   └── ui/                       # componente accesibile comune
├── db/
│   ├── schema.sql                # schema de pornire (devine prima migrare)
│   ├── migrations/
│   └── seed/                     # sarbatori legale, roluri, termene (to_validate), pachete P1/P2/P5
├── examples/
│   └── process-p1.json           # definitia procesului P1 (forma propusa)
├── deploy/
│   ├── docker-compose.yml        # api, worker, web, postgres, seaweedfs, libreoffice, dss
│   └── ghid-instalare.md         # max. 2 pagini
├── tests/
│   ├── e2e/                      # Playwright: P1 cap-coada
│   └── load/                     # k6: 200 de utilizatori, deschidere dosar < 1 s
└── docs/
```

Monorepo cu **pnpm workspaces**; `packages/*` nu depind de NestJS sau React, ca sa poata fi
testate unitar si folosite in ambele parti.

## 3. Componente si licente

Regula din prompt: nicio componenta cu licenta care interzice revanzarea ca serviciu.

| Componenta | Licenta | Observatie |
|---|---|---|
| PostgreSQL | PostgreSQL License | – |
| NestJS, React, Kysely, pg-boss, docxtemplater (core) | MIT | modulele platite docxtemplater nu sunt necesare in Faza 1 |
| LibreOffice | MPL 2.0 | rulat ca proces separat, nemodificat |
| EU DSS | LGPL 2.1 | rulat ca serviciu separat, nemodificat |
| SeaweedFS | Apache 2.0 | stocare S3 in docker-compose |
| **MinIO** | AGPL v3 | **evitat ca implicit**: in 2025 a oprit distributia de binare/imagini pentru editia comunitara si a scos consola de administrare; clientul il poate folosi daca il are deja (interfata S3) |
| **Redis** | RSAL/SSPL (7.4), AGPL (8.x) | **evitat**: pg-boss inlocuieste coada; daca va fi nevoie, Valkey (BSD) |
| Camunda 7 CE | – | final de viata oct. 2025, de aceea nu e optiune |
| n8n | Sustainable Use | interzice revanzarea ca serviciu, exclus |

## 4. Fluxul unei cereri prin sistem (P1, simplificat)

```
Registratura ─► [inregistrare: numar din registrul general, emitent = beneficiar ANAF]
              ─► pornire instanta P1 (precompletare din proiect + beneficiar + ultimele valori)
Expert EVF   ─► lista de verificare + tabel cheltuieli + constatari
   (paralel) ─► Expert EI, daca dubla verificare e activa       ─┐
                                                                  ├─ join "toti"
Clarificari  ─► (optional) suspendare termen, scrisoare generata ─┘
Sef serviciu ─► aviz (semnatura) sau returnare cu motiv obligatoriu
CFPP         ─► viza (conditie configurabila)
Director     ─► aprobare + semnatura calificata + numar de iesire
Sistem       ─► notificare beneficiar (document generat), inregistrare in registrul CR/CP
```

Fiecare sageata este o tranzitie: o tranzactie care valideaza drepturile si campurile
obligatorii, scrie starea noua, inchide/deschide sarcini, recalculeaza termenele si scrie
evenimentul de audit. Automatizarile lente (PDF, email) pleaca in coada **dupa** commit
(pattern outbox: tabela `job_outbox` scrisa in aceeasi tranzactie).

## 5. Motorul de flux – reguli de executie

- O definitie publicata este **imutabila**; o modificare creeaza o versiune noua. Instantele
  raman pe versiunea cu care au pornit (`instance.definition_id`).
- Starea de executie este tinuta in `execution` (un „jeton” pe ramura activa). Un pas paralel
  creeaza cate o executie pe ramura; join-ul `all` asteapta toate ramurile, `any` o anuleaza pe
  cele ramase.
- O sarcina umana (`task`) are fie un titular (`assignee_user_id`), fie un rol/departament
  candidat (coada comuna, preluata de un membru). Repartizarea automata foloseste o regula din
  definitie: `fixed`, `role_queue`, `project_expert`, `least_loaded`.
- **Returnarea** la un pas anterior marcheaza semnaturile date de la acel pas incoace ca
  `invalidated` (cu motiv), anuleaza sarcinile deschise de dupa acel pas si pastreaza tot istoricul.
- Returnarea intr-un pas din interiorul unei zone paralele redeschide doar ramura respectiva;
  join-ul asteapta numai ramurile active in trecerea curenta (in P1: seful returneaza la EVF fara
  a redeschide verificarea EI, daca nu cere explicit).
- Conditiile (pe cai si pe pasi de decizie) folosesc un limbaj de expresii restrans (JSONLogic),
  evaluat pe valorile campurilor; nu se executa cod arbitrar din definitii.
- Actiunea „in numele” titularului se inregistreaza cu `actor_user_id` (inlocuitorul) si
  `on_behalf_of_user_id` (titularul) atat pe sarcina, cat si in audit.
- Separarea functiilor este o regula a definitiei (`separationOfDuties`), verificata la tranzitie:
  cel care a completat pasul X nu poate finaliza pasul Y; EVF si EI trebuie sa fie persoane diferite.

## 6. Performanta (criteriul 6)

Deschiderea unui dosar = 1 interogare pentru instanta + campuri + sarcini active, 1 pentru
documente, 1 pentru istoricul pasilor (paginat), toate pe indexuri dupa `instance_id`.
Drepturile se verifica printr-o singura interogare pe `instance_acl` + atribuirile de rol
active. Istoricul complet de audit se incarca la cerere, nu la deschidere. Testul k6 din
`tests/load` este parte din pipeline-ul de release.
