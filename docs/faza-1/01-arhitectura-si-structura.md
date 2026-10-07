# Flux AM – Faza 1: arhitectura si structura proiectului

## 1. Decizii principale

| Decizie | Alegere | Motiv |
|---|---|---|
| Forma aplicatiei | **monolit modular** (un API, module cu granite clare) + worker pentru joburi | o echipa de 3-4 oameni, instalare on-premise simpla; modulele pot fi separate ulterior |
| Backend | **TypeScript, Fastify 5**, Node 22 LTS | aceeasi limba cu frontend-ul si cu schema definitiilor de proces (tipuri partajate). *La implementare: Fastify in locul NestJS (mai putine straturi, testare directa cu `inject`, OpenAPI din aceleasi rute).* |
| Baza de date | **PostgreSQL 16** | tranzactii pentru contoare, JSONB pentru valori de formular, full-text, triggere pentru audit |
| Acces la date | **`pg` cu SQL scris de mana** + migrari SQL (*initial: Kysely*) | controlam exact SQL-ul pentru contoare, blocari si audit; schema este [`db/migrations/0001_schema.sql`](../../db/migrations/0001_schema.sql) |
| Motor de flux | **propriu**, definitii JSON validate cu JSON Schema | semantica necesara (matrice camp x pas, termene cu suspendari, invalidarea semnaturilor la returnare, inlocuiri) e specifica produsului; Flowable ar aduce un runtime Java si un al doilea model de date fara sa rezolve aceste parti. Pastram un `WorkflowEngine` ca interfata, deci un adaptor Flowable ramane posibil |
| Coada de joburi | **outbox tranzactional propriu** pe PostgreSQL (`job_outbox`, `FOR UPDATE SKIP LOCKED`) + worker (*initial: pg-boss*) | fara Redis si fara dependenta in plus; jobul se creeaza in aceeasi tranzactie cu schimbarea care il cere |
| Fisiere | stocare **adresata dupa continut** (cheia = SHA-256) pe sistemul de fisiere, verificata la fiecare citire; o implementare S3 se poate adauga in spatele acelorasi functii | vezi sectiunea 3 despre MinIO |
| Documente | **docxtemplater** (MIT, modulele de baza) pentru DOCX; **LibreOffice** pentru PDF: container **Gotenberg** (MIT) in docker-compose sau `soffice` local | prompt, sectiunea 13 |
| Semnatura | adaptor `SignatureProvider` (un furnizor in Faza 1); validare cu **EU DSS** ca serviciu separat | PAdES B-LTA si validarea nu au biblioteci mature in Node |
| Frontend | **React + TypeScript**, Vite, React Router, TanStack Query, HTML semantic si CSS propriu (fara biblioteca de componente) | WCAG 2.1 AA |
| Autentificare | sesiuni server-side (cookie HttpOnly, SameSite) + parola scrypt + TOTP; OIDC planificat | un portal intern; revocare imediata a sesiunii |
| Observabilitate | loguri JSON (pino), metrici Prometheus, `/health` si `/ready` | prompt, sectiunea 13 |

## 2. Structura repository-ului (implementata)

```
adr/
├── apps/
│   ├── api/                      # Fastify: REST API + OpenAPI (/api/docs), serveste si interfata web
│   │   ├── src/
│   │   │   ├── auth/             # sesiuni, parole (scrypt), TOTP, criptarea secretelor
│   │   │   ├── identity/         # utilizatorul curent: roluri active, inlocuiri
│   │   │   ├── access/           # drepturi pe dosar (instance_acl)
│   │   │   ├── audit/            # scriere in jurnalul cu lant de hash-uri
│   │   │   ├── workflow/         # Modulul 1: motorul de flux, sarcini, rutele dosarelor
│   │   │   ├── forms/            # Modulul 2: valori cu provenienta, liste de articole, campuri calculate
│   │   │   ├── documents/        # stocare, sabloane DOCX, conversie PDF, versiuni
│   │   │   ├── registry/         # Modulul 3: registre, numerotare, emitenti, export
│   │   │   ├── deadlines/        # Modulul 4: termene, suspendari, reamintiri, escaladare
│   │   │   ├── signing/          # Modulul 5: furnizor de semnatura (interfata), validare DSS
│   │   │   ├── integrations/anaf # interogare ANAF dupa CUI
│   │   │   ├── reference/        # beneficiari, proiecte, import XLSX, nomenclatoare
│   │   │   ├── reporting/        # tablou de bord, export XLSX
│   │   │   ├── admin/            # utilizatori, roluri, calendar, termene, definitii, sabloane, audit
│   │   │   ├── jobs/             # outbox: generare documente, e-mail, apeluri REST
│   │   │   ├── seed/             # instalare initiala + date demo + sabloanele DOCX implicite
│   │   │   ├── main.ts           # API (cluster pe nuclee)
│   │   │   └── worker.ts         # joburi si scanarea termenelor
│   │   └── test/                 # teste de integrare pe PostgreSQL real (P1 cap-coada, fluxuri)
│   └── web/                      # React: Panoul meu, Dosare, Dosarul, Registre, Tablou, Administrare, Cont
├── packages/
│   ├── process-schema/           # JSON Schema + tipuri + validare definitii + reguli JSONLogic
│   ├── working-days/             # calendar si termene (fara dependente)
│   └── validators/               # CUI, IBAN, cod SMIS, sume in bani (BigInt), formate RO
├── processes/                    # pachetele P1, P2, P5: process.json + checklist.json
├── db/
│   ├── migrations/               # SQL, aplicate automat la pornire
│   └── tests/verify-schema.sh    # garantii ale schemei (numerotare, audit, imutabilitate)
├── deploy/                       # docker-compose.yml, .env.example, backup/restore, ghid de instalare
├── tests/
│   ├── e2e/                      # Playwright: dosar P1 prin interfata, cu patru utilizatori
│   └── load/                     # test de incarcare: deschiderea dosarului la 200 de utilizatori
└── docs/
```

Monorepo cu **pnpm workspaces**. Pachetele din `packages/` sunt TypeScript sursa (fara pas de
build), folosite de API (prin `tsx`) si de interfata (prin Vite).

## 3. Componente si licente

Regula din prompt: nicio componenta cu licenta care interzice revanzarea ca serviciu.

| Componenta | Licenta | Observatie |
|---|---|---|
| PostgreSQL | PostgreSQL License | – |
| Fastify, React, pg, docxtemplater (core), json-logic-js, ajv, exceljs, pdf-lib | MIT | modulele platite docxtemplater nu sunt necesare |
| Gotenberg | MIT | LibreOffice prin HTTP, container separat |
| LibreOffice | MPL 2.0 | rulat ca proces separat, nemodificat |
| EU DSS | LGPL 2.1 | rulat ca serviciu separat, nemodificat |
| **MinIO** | AGPL v3 | **evitat ca implicit**: in 2025 a oprit distributia de binare/imagini pentru editia comunitara si a scos consola de administrare; clientul il poate folosi daca il are deja (interfata S3) |
| **Redis** | RSAL/SSPL (7.4), AGPL (8.x) | **evitat**: coada este pe PostgreSQL; daca va fi nevoie, Valkey (BSD) |
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
