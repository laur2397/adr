# Flux AM – documentație tehnică

Versiunea: octombrie 2026 (Faza 1 + Faza 2). Document de referință pentru dezvoltatori, administratori
IT și auditori tehnici. Detalii suplimentare pe teme punctuale:
[arhitectura inițială](faza-1/01-arhitectura-si-structura.md),
[modelul de date](faza-1/02-model-date.md), [contractele API](faza-1/03-contracte-api.md),
[analiza de piață](faza-2/analiza-piata.md), [ghidul de instalare](../deploy/ghid-instalare.md).

## Cuprins

1. [Scop și context](#1-scop-și-context)
2. [Arhitectura](#2-arhitectura)
3. [Structura codului](#3-structura-codului)
4. [Modelul de date](#4-modelul-de-date)
5. [Motorul de flux](#5-motorul-de-flux)
6. [Limbajul definițiilor de proces](#6-limbajul-definițiilor-de-proces)
7. [Procesele livrate (P1–P8)](#7-procesele-livrate-p1p8)
8. [Formulare, sume și calcule](#8-formulare-sume-și-calcule)
9. [Registre și numerotare](#9-registre-și-numerotare)
10. [Termene](#10-termene)
11. [Documente și semnătură](#11-documente-și-semnătură)
12. [Controale de verificare (art. 74)](#12-controale-de-verificare-art-74)
13. [Verificări la fața locului și modulul de teren](#13-verificări-la-fața-locului-și-modulul-de-teren)
14. [Nereguli și debitori](#14-nereguli-și-debitori)
15. [Arhivă](#15-arhivă)
16. [Colaborare, căutare, notificări](#16-colaborare-căutare-notificări)
17. [Integrări](#17-integrări)
18. [Securitate și acces](#18-securitate-și-acces)
19. [Jurnalul de audit](#19-jurnalul-de-audit)
20. [API REST](#20-api-rest)
21. [Interfața web](#21-interfața-web)
22. [Joburi în fundal (worker)](#22-joburi-în-fundal-worker)
23. [Configurare (variabile de mediu)](#23-configurare-variabile-de-mediu)
24. [Instalare, operare, backup](#24-instalare-operare-backup)
25. [Date demo și simulatorul](#25-date-demo-și-simulatorul)
26. [Testare](#26-testare)
27. [Extindere: cum adaugi un proces nou](#27-extindere-cum-adaugi-un-proces-nou)
28. [Limitări cunoscute și pași următori](#28-limitări-cunoscute-și-pași-următori)

---

## 1. Scop și context

Flux AM este un sistem de management electronic al documentelor și al fluxurilor de lucru
(EDMS + workflow) pentru Agențiile pentru Dezvoltare Regională și alte Autorități de Management /
Organisme Intermediare care gestionează fonduri europene. Acoperă:

- registratura (intrări, ieșiri, registre speciale cu numerotare fără goluri);
- circuitele interne de verificare și avizare (cereri de rambursare/plată, achiziții, acte
  adiționale, nereguli, referate și plăți, decizii, corespondență și petiții);
- documentele generate din șabloane DOCX, convertite în PDF și semnate în ordine;
- termenele legale în zile lucrătoare, cu suspendări, reamintiri și escaladare;
- controalele cerute de verificările de management (conflict de interese, dublă finanțare,
  eșantionare pe bază de risc);
- arhiva (nomenclator, termene de păstrare, eliminare), integrările (API, webhook-uri, e-mail);
- trasabilitatea completă (jurnal de audit append-only cu lanț de hash-uri).

Instalarea țintă este **on-premise** la instituție (docker-compose), cu o singură organizație pe
instalare (schema permite mai multe, prin `organization_id` pe toate tabelele principale).

## 2. Arhitectura

```
            ┌──────────────────────── browser ────────────────────────┐
            │  React 19 + Vite (SPA), TanStack Query, react-router 7  │
            └──────────────────────────┬──────────────────────────────┘
                                       │ HTTPS, cookie de sesiune + antet X-Flux-Csrf
                                       ▼
┌────────────────────────── API (Fastify 5, Node 22) ──────────────────────────┐
│ auth · access · workflow · forms · documents · registry · deadlines · signing│
│ controls · debts · archive · collaboration · search · reporting · admin      │
│ integrations (anaf, mail, hooks) · audit                     /api/docs (OpenAPI)
└───────────┬─────────────────────────────────┬────────────────────────────────┘
            │ SQL (pg), tranzacții            │ fișiere adresate după SHA-256
            ▼                                 ▼
   ┌──────────────────┐               ┌─────────────────┐
   │ PostgreSQL 16    │               │ STORAGE_DIR     │
   │ schema `flux`    │◄──────┐       └─────────────────┘
   │ + job_outbox     │       │
   └──────────────────┘       │ FOR UPDATE SKIP LOCKED
                     ┌────────┴─────────────────────────────────────────┐
                     │ Worker: outbox (PDF, e-mail, webhook, REST),     │
                     │ scanarea termenelor, citirea căsuței IMAP        │
                     └────────┬───────────────────────┬─────────────────┘
                              ▼                       ▼
                   Gotenberg / soffice          SMTP, IMAP, ANAF, webhook-uri
```

Decizii principale:

| Decizie | Alegere | Motiv |
|---|---|---|
| Forma | monolit modular + worker | echipă mică, instalare simplă; modulele au granițe clare |
| Backend | TypeScript, Fastify 5, Node 22 | același limbaj cu interfața și cu schema proceselor |
| Date | PostgreSQL 16, SQL scris de mână (`pg`) | control exact pe blocări, contoare, audit |
| Motor de flux | propriu, definiții JSON validate cu JSON Schema | semantica specifică (matrice câmp × pas, returnări care invalidează semnături, termene cu suspendări, înlocuiri) |
| Coadă | outbox tranzacțional pe PostgreSQL | fără Redis; jobul se scrie în aceeași tranzacție cu schimbarea |
| Fișiere | sistem de fișiere, cheie = SHA-256, verificată la citire | integritate; S3 poate fi adăugat în spatele acelorași funcții |
| Documente | docxtemplater (DOCX) + LibreOffice (Gotenberg sau `soffice`) pentru PDF | formate cerute de instituții, licențe permisive |
| Semnătură | adaptor `SignatureProvider`; validare EU DSS opțională | furnizorul calificat se alege ulterior |
| Interfață | React, CSS propriu, HTML semantic | WCAG 2.1 AA, fără bibliotecă de componente |

Componentele terțe au licențe permisive (MIT, PostgreSQL, MPL pentru LibreOffice rulat separat,
LGPL pentru EU DSS rulat separat). MinIO și Redis sunt evitate intenționat (licențe AGPL/SSPL).

## 3. Structura codului

Monorepo **pnpm workspaces**. Pachetele din `packages/` sunt TypeScript sursă (`exports` →
`./src/index.ts`), fără pas de build: API-ul rulează cu `tsx`, interfața le consumă prin Vite.

```
apps/api/src/
  main.ts, worker.ts          puncte de intrare (API în cluster, worker)
  app.ts                      construirea aplicației Fastify: autentificare, CSRF, rute, fișiere statice
  core/                       config, db (pool, tx), erori (AppError), migrări, outbox
  auth/                       login, sesiuni, scrypt, TOTP, criptare AES-256-GCM
  identity/                   utilizatorul curent: roluri active, înlocuiri
  access/policy.ts            drepturi pe dosar, rol de supraveghere (director, admin funcțional, auditor)
  workflow/                   engine.ts (motorul), load.ts (definiții), routes.ts (dosare, sarcini)
  forms/store.ts              valori cu proveniență, liste (tabele), câmpuri calculate
  documents/                  stocare, randare DOCX, conversie PDF, versiuni
  signing/                    furnizori de semnătură, semnare individuală și în lot
  registry/                   registre, numerotare, emitenți (correspondents), export
  deadlines/service.ts        calcul, suspendare, reamintiri, escaladare
  controls/                   coi.ts, invoices.ts (dublă finanțare), sampling.ts, routes.ts (IMS, lot)
  debts/                      registrul debitorilor, încasări
  archive/                    nomenclator, dosare de arhivă, eliminare
  collaboration/              comentarii, @mențiuni
  search/                     index text, căutare globală
  reporting/                  tablou de bord, export XLSX
  reference/                  beneficiari (ANAF), proiecte, import XLSX, nomenclatoare, utilizatori
  integrations/anaf|mail|hooks  ANAF, coada de e-mail (IMAP/.eml), tokenuri API, webhook-uri
  notifications/              notificări în aplicație și e-mail
  audit/audit.ts              scrierea în jurnal + declanșarea webhook-urilor
  jobs/runner.ts              execuția joburilor din outbox
  admin/                      utilizatori, roluri, calendar, termene, definiții, șabloane, audit
  seed/                       base.ts (instalare), demo.ts, templates.ts, simulate.ts
  cli/                        migrate.ts, seed.ts
apps/api/test/                teste de integrare pe PostgreSQL real
apps/web/src/                 SPA: pages/, components/, api.ts, format.ts
packages/process-schema/      JSON Schema a definițiilor, tipuri, validare, reguli JSONLogic, formulare
packages/working-days/        calendar și termene în zile lucrătoare (fără dependențe)
packages/validators/          CUI, IBAN, cod SMIS, sume în bani (BigInt)
processes/p1..p7/             definițiile proceselor (process.json, checklist.json)
db/migrations/                0001_schema, 0002_runtime_additions, 0003_phase2, 0004_controls
db/tests/verify-schema.sh     verificarea garanțiilor schemei
deploy/                       docker-compose, .env.example, backup/restore, ghid de instalare
.devcontainer/                GitHub Codespaces (demo online)
tests/e2e, tests/load         Playwright, test de încărcare
```

## 4. Modelul de date

Toate tabelele sunt în schema PostgreSQL `flux`. Migrările din `db/migrations/*.sql` se aplică
automat la pornire (sau cu `pnpm db:migrate`), în ordine, o singură dată.

| Domeniu | Tabele |
|---|---|
| Organizație și identitate | `organization`, `department`, `app_user`, `role`, `role_assignment`, `substitution`, `user_session`, `api_token` |
| Referință | `program`, `priority`, `call_for_proposals`, `beneficiary`, `project`, `project_budget_line`, `nomenclature`, `nomenclature_item` |
| Calendar și termene | `holiday`, `working_day_exception`, `deadline_definition`, `deadline`, `deadline_pause` |
| Flux | `process_definition`, `instance`, `execution`, `task`, `step_history`, `instance_acl` |
| Formulare | `instance_field`, `instance_list_row`, `checklist_template`, `checklist_item`, `checklist_response`, `instance_checklist` |
| Documente | `document_template`, `document`, `document_version`, `signature` |
| Registratură | `correspondent`, `register`, `register_counter`, `register_entry`, `mail_message` |
| Arhivă | `archive_nomenclature_item`, `archive_file` |
| Controale | `coi_declaration`, `invoice_fingerprint`, `sampling_plan`, `sampling_visit` |
| Vizite pe teren | `visit_evidence` (fotografii și semnătură, cu oră, GPS și amprentă) |
| Nereguli/debite | `debt`, `debt_payment` |
| Colaborare | `instance_comment`, `notification` |
| Infrastructură | `job_outbox`, `webhook`, `audit_event`, `processing_activity` |

Puncte importante:

- **Sume**: coloane `numeric(18,2)`; în aplicație sumele circulă ca șiruri și se calculează în
  bani cu `BigInt` (pachetul `validators`), niciodată în virgulă mobilă.
- **Definițiile de proces** (`process_definition.definition jsonb`) sunt imutabile după publicare;
  un trigger refuză modificarea, iar un index unic permite o singură versiune publicată pe cheie.
- **Instanța** (`instance`) păstrează `definition_id` (versiunea cu care a pornit),
  `parent_instance_id` pentru sub-fluxuri, `search_text` cu index GIN pentru căutare.
- **Execuția** (`execution`) este „jetonul” unei ramuri active; `child_instance_id` leagă un pas
  de tip sub-flux de dosarul-copil.
- **Câmpurile** (`instance_field`) au proveniență (`source`: utilizator, proiect, ANAF, dosar
  anterior, calculat), cu autorul și momentul ultimei modificări.
- **Audit**: `audit_event` este append-only (trigger care refuză UPDATE/DELETE), cu `prev_hash` și
  `hash`; funcția `audit_verify_chain()` întoarce primul rând alterat.
- **Extensii**: `pgcrypto` și `unaccent` instalate în schema `public`.

## 5. Motorul de flux

Fișier: `apps/api/src/workflow/engine.ts`. Toate operațiile rulează într-o singură tranzacție.

**Tranziția** (`POST /instances/:id/transitions` cu `taskId`, `path`, `comment`):

1. blochează instanța (`for update`), verifică că sarcina e deschisă și că utilizatorul o poate
   executa (titular, înlocuitor sau membru al cozii);
2. verifică declarația de conflict de interese, dacă pasul o cere;
3. validează câmpurile obligatorii ale pasului (matricea câmp × pas) și listele de verificare,
   dacă calea nu are `validateFields: false`;
4. verifică semnăturile cerute de cale (`requiresSignatures`) și separarea funcțiilor;
5. execută acțiunile căii, închide sarcina, scrie `step_history`;
6. avansează: pași de decizie (reguli JSONLogic), ramificări/reuniri paralele, pași de sistem
   (acțiuni `onEnter`), sub-fluxuri; creează sarcinile noi conform regulii de repartizare;
7. recalculează termenele, reindexează textul de căutare, scrie evenimentul de audit
   (care pune în outbox și webhook-urile).

Jobul lent (PDF, e-mail, webhook) se execută după commit, din outbox. Efectele care trebuie anulate
la rollback folosesc `AppError.onRollback`.

**Repartizare** (`assignment.rule`): `fixed_user`, `role_queue` (coadă comună, preluare cu „Preia”),
`project_expert` (expertul alocat proiectului), `least_loaded` (cel mai puțin încărcat din rol),
`previous_actor`, `department_head` (șeful departamentului inițiatorului/expertului),
`chosen_by_previous` (ales în pasul anterior, ex. rezoluția directorului).

**Returnări**: o cale `kind: "return"` duce la un pas anterior; semnăturile date de atunci încoace
devin `invalidated` (cu motiv), sarcinile ulterioare se anulează, istoricul se păstrează. Într-o zonă
paralelă se redeschide doar ramura țintă.

**Paralelism**: `parallel_split` creează o execuție pe ramură; `parallel_join` cu `join: "all"`
așteaptă toate ramurile active, `any` le anulează pe celelalte.

**Sub-fluxuri**: pasul `subflow` (sau acțiunea `start_subflow`) pornește un dosar-copil cu
`inputs` (mapare câmp-părinte → câmp-copil; valoarea `"=text"` înseamnă constantă). Dacă pasul
așteaptă, la finalizarea copilului `outputs` se copiază înapoi și părintele continuă
(`resumeParent`). Exemplu activ: P2 cu verdict „aviz cu corecție” deschide P4.

**Înlocuiri**: un utilizator în concediu are un înlocuitor (`substitution`); acesta vede și
execută sarcinile titularului, iar acțiunea se înregistrează cu `actor_user_id` și
`on_behalf_of_user_id`.

**Separarea funcțiilor** (`separationOfDuties`): perechi de pași care nu pot fi făcuți de aceeași
persoană (ex. EVF ≠ EI; cel care întocmește referatul ≠ viza CFPP).

## 6. Limbajul definițiilor de proces

Schema: `packages/process-schema/process-definition.schema.json` (`schemaVersion: 1`). Validarea
(`validate.ts`) aplică JSON Schema (ajv) plus verificări de coerență: referințe la pași, câmpuri,
documente, registre și termene existente, pași de final atinși, reguli valide.

Elemente principale ale unei definiții:

| Element | Conținut |
|---|---|
| `key`, `name`, `version` | identificare; versiunile se publică din Administrare |
| `subject.requires` | `project`, `beneficiary`, `program`, `register_entry` |
| `fields[]` | tip (`text`, `textarea`, `integer`, `amount`, `percent`, `boolean`, `date`, `datetime`, `choice`, `multichoice`, `user`, `beneficiary`, `project`, `file`, `line_items`, `calculated`), format (`cui`, `iban`, `smis_code`, `email`), `prefill.from` (`project`, `beneficiary`, `anaf`, `previous_instance`, `register_entry`, `constant`), coloane pentru tabele, `formula` + `resultType` pentru calculate |
| `steps[]` | tip (`start`, `human`, `system`, `decision`, `parallel_split`, `parallel_join`, `subflow`, `end_positive`, `end_negative`), `assignment`, `fieldAccess` (`hidden`, `visible`, `editable`, `required` pe câmp), `paths[]`, `onEnter[]`, `checklist`, `inputs/outputs` |
| `paths[]` | `label`, `to`, `kind` (`forward`, `return`, `reject`), `condition`, `requiresSignatures`, `requireComment`, `validateFields`, `actions[]` |
| `actions[]` | `set_field`, `generate_document`, `request_signatures`, `notify`, `register` (cu `once`), `call_rest`, `start_subflow`, `grant_access`, `pause_deadline`, `resume_deadline`, `update_budget_lines`, `create_debt`, `update_project` |
| `documents[]` | `key`, `template`, `docType`, `signatureLevel` (`simple`, `advanced`, `qualified`, `seal`) |
| `deadlines[]` | definiția de termen folosită, pasul de start/stop, `when` (condiție) |
| `checklists[]` | listă de verificare, `verifierRoles` (`primary`, `second` pentru dubla verificare) |
| `separationOfDuties[]`, `conflictOfInterest`, `invoiceCheck` | controale |

**Reguli** (`rules.ts`): JSONLogic restrâns, evaluat pe valorile câmpurilor, cu operatori proprii
pentru sume exacte: `amount_add`, `amount_sub`, `amount_mul`, `amount_sum`, `amount_lte`,
`amount_lt`, `amount_gte`, `amount_eq`. Nu se execută cod arbitrar din definiții
(`safeEvaluate` prinde orice eroare de evaluare).

## 7. Procesele livrate (P1–P8)

Fiecare proces se află în `processes/<pN>/process.json`.

### P1 – Verificarea cererii de rambursare / plată / prefinanțare
Registre: general, CR/CP, vize CFPP. Termene: verificarea cererii, țintă internă financiară.
Conflict de interese pe EVF, EI, șef, CFPP, director. Dublă finanțare pe tabelul de cheltuieli.

```
Înregistrare (registratură) ─► ramificare ─┬─ Verificare financiară EVF ⇄ Clarificări (termen suspendat)
                                            └─ Verificare tehnică EI
─► reunire ─► Avizare șef serviciu ─► [viză CFPP necesară?] ─► Viza CFPP ─► Aprobare director
─► Notificare beneficiar (document) ─► Înregistrare CR/CP ─► Finalizat
Returnări: șef → EVF, CFPP → șef, director → șef. Anulare la înregistrare.
```

### P2 – Verificarea dosarului de achiziție
Înregistrare → Verificare achiziție (cel mai puțin încărcat expert) → Avizare șef → Aprobare director
→ Înregistrare în registrul achizițiilor. La verdict „aviz cu corecție” pornește automat P4.

### P3 – Acte adiționale și notificări
Înregistrare → Analiză tehnică și financiară → [act adițional?] → Aviz juridic (doar act adițional)
→ Avizare șef → Aprobare director (aprobă / respinge / returnează) → Înregistrare și actualizarea
contractului (`update_project`: data de final, valoarea eligibilă).

### P4 – Nereguli și debitori
Sesizare (ofițer nereguli) → Verificare și constatare → Avizare șef → Aprobare director → Titlu de
creanță (`create_debt`) și registrul debitorilor, sau clasare dacă neregula nu se confirmă.

### P5 – Registratură generală și corespondență
Înregistrare → Rezoluție conducere → Soluționare (persoana aleasă la rezoluție) → Semnare răspuns
→ Înregistrare ieșire și expediere. Termene: petiții (OG 27/2002), informații publice (Legea
544/2001), corespondență generală.

### P6 – Referat de necesitate, angajare și ordonanțare la plată
Întocmire referat (TVA calculat exact) → Aprobare șef → Viza CFPP angajament → Aprobare angajare
(director) → Recepție și factură → Ordonanțare (contabil) → Viza CFPP plată → Aprobare plată
(ordonator) → Plată. Factura nu poate depăși angajamentul; întocmitorul nu poate da viza CFPP.

### P7 – Decizii ale directorului
Proiect → Aviz șef compartiment → Aviz de legalitate → Semnare director → Comunicare. Numărul
deciziei se alocă înainte de semnare și se păstrează la returnare.

### P8 – Verificare la fața locului
Programare (din eșantion sau la cerere) → notificarea beneficiarului → vizita (listă de verificare,
fotografii cu GPS, semnătura reprezentantului) → avizare șef → aprobare director → comunicare →
încheiere, urmărirea recomandărilor sau sesizare automată P4. Detalii în secțiunea 13.

Roluri folosite: `registry_inspector`, `evf_expert`, `ei_expert`, `procurement_expert`,
`head_of_unit`, `director`, `cfpp`, `legal_advisor`, `irregularity_officer`, `accountant`,
`functional_admin`, `it_admin`, `auditor`.

## 8. Formulare, sume și calcule

- Valorile se salvează pe câmp (`PATCH /instances/:id/fields`) și pe tabel
  (`PUT /instances/:id/lists/:key`), doar dacă pasul curent le face editabile.
- Precompletarea vine din proiect, beneficiar (inclusiv ANAF după CUI), dosarul anterior al
  aceluiași proiect sau registrul de intrare; proveniența se afișează lângă câmp.
- Câmpurile calculate (inclusiv coloanele calculate din tabele) se recalculează la fiecare salvare
  (`refreshCalculated`) cu operatorii de sumă exacți.
- Validatorii (`packages/validators`): CUI (cifră de control), IBAN (mod 97), cod SMIS, sume
  (`parseAmount`, `addAmounts`, `multiplyAmount` cu rotunjire la bani).
- Listele de verificare (`PUT /instances/:id/checklists/:key/responses`): răspuns Da/Nu/N/A și
  observație pe punct; pentru dubla verificare, verificatorul al doilea are coloana sa.

## 9. Registre și numerotare

- Registre implicite: general, CR/CP, achiziții, contracte, acte adiționale, decizii, nereguli,
  debitori, garanții, conflicte de interese, referate de necesitate, ordonanțări, vize CFPP.
- Numărul se alocă prin `next_register_number()`: rândul din `register_counter` se blochează
  (`for update`) în tranzacția care creează intrarea, deci numerele sunt **consecutive și fără
  goluri** chiar și la cereri concurente; o tranzacție anulată nu consumă număr. Contorul se
  resetează anual.
- Emitenții/destinatarii (`correspondent`) se deduplică după CUI sau nume normalizat.
- Intrările se pot conexa între ele și cu dosarul; registrele se exportă în Excel.

## 10. Termene

Pachet `packages/working-days` + `apps/api/src/deadlines/service.ts`.

- Definițiile (`deadline_definition`) au: durată, unitate (zile lucrătoare/calendaristice),
  pragurile de reamintire și escaladare, plafonul de suspendare, temeiul legal și marcajul
  „de validat juridic”.
- Calculul ține cont de sărbătorile legale (`holiday`) și de excepții (`working_day_exception`).
- `pause_deadline`/`resume_deadline` (ex. clarificări în P1) suspendă termenul; zilele suspendate
  se adaugă la scadență, în limita plafonului.
- Workerul scanează periodic (`DEADLINE_INTERVAL_MS`): trimite reamintiri, marchează depășirile și
  escaladează la șef.
- Tabloul de bord arată termenele în curs, depășite și respectate.

## 11. Documente și semnătură

**Generare**: șabloanele DOCX (`document_template`, docxtemplater) primesc valorile dosarului,
proiectului, beneficiarului, tabelele și listele de verificare. DOCX-ul se convertește în PDF prin
Gotenberg (`GOTENBERG_URL`) sau LibreOffice local (`SOFFICE_PATH`). Fiecare generare creează o
versiune nouă (`document_version`) cu hash SHA-256; fișierele sunt stocate după conținut.

Șabloane livrate: nota de verificare, scrisoarea de clarificări, notificarea de autorizare (P1),
nota de verificare a achiziției (P2), nota de analiză și actul adițional (P3), procesul-verbal de
constatare și titlul de creanță (P4), răspunsul (P5), referatul și ordonanțarea (P6), decizia (P7).

**Semnare**: `POST /instances/:id/documents/:docKey/sign` sau în lot
(`POST /signatures/batch`, butonul „Semnează toate” din Panoul meu). Ordinea semnatarilor urmează
pașii; o returnare invalidează semnăturile de după pasul țintă.

Furnizori (`SIGNATURE_PROVIDER`):
- `simulated` – aplică pe PDF o ștampilă vizibilă „SIMULARE” (pdf-lib). Doar pentru demo și
  teste; în producție este refuzat dacă `ALLOW_SIMULATED_SIGNATURES` nu este activat.
- adaptorul pentru un furnizor calificat (PAdES) se implementează pe interfața `SignatureProvider`;
  apelul de retur vine pe `POST /signatures/callback/:provider`.
- validarea semnăturilor externe se poate face cu EU DSS (`DSS_URL`).

## 12. Controale de verificare (art. 74)

**Conflict de interese** (`controls/coi.ts`, tabel `coi_declaration`). Pe pașii din
`conflictOfInterest.steps`, înainte de orice acțiune (salvare, preluare, tranziție) verificatorul
semnează o declarație pe propria răspundere (`POST /instances/:id/coi`). Fără declarație API-ul
răspunde cu codul `coi_required`. Dacă declară conflict, sarcina revine în coadă, șeful e
notificat, iar persoana nu mai poate lucra pe dosar (`coi_conflict`). Declarațiile intră în
registrul conflictelor de interese.

**Dubla finanțare** (`controls/invoices.ts`, tabel `invoice_fingerprint`). Fiecare rând din
tabelul de cheltuieli cu CUI furnizor + număr de factură este indexat cu numărul normalizat
(fără spații, prefixe și zerouri inițiale). Aceeași factură apărută în alt dosar, din orice proiect
sau program, produce alertă în dosar (`GET /instances/:id/double-funding`) și crește scorul de risc.

**Eșantionare pe bază de risc** (`controls/sampling.ts`, tabel `sampling_plan`). Populația:
dosarele unui proces într-un interval. Scorul de risc (0–100) are ponderile: valoare 30%,
reduceri/sume neeligibile 20%, nereguli anterioare 25%, alerte de dublă finanțare 15%, beneficiar
nou 10%. Dosarele peste prag intră automat; restul se aleg aleator ponderat cu un PRNG determinist
(sfc32) inițializat din SHA-256 al seminței. Sămânța, factorii și selecția se salvează, deci
auditul poate reproduce exact eșantionul. Metode: `risk_weighted`, `simple_random`.

**Lista IMS** (`GET /irregularities`): neregulile cu impact ≥ 10.000 EUR (curs `EUR_RON`, implicit
4,97) sau marcate manual pentru raportare.

## 13. Verificări la fața locului și modulul de teren

Pachetul P8 (`processes/p8`) și modulul `apps/api/src/visits/` acoperă verificările la fața locului
cerute de art. 74 alin. 2 din Regulamentul (UE) 2021/1060, de la eșantion până la urmărirea
recomandărilor.

**Pornire.** Vizitele se deschid fie din planul de eșantionare (`POST /sampling/:id/visits`
creează câte un dosar P8 pentru fiecare dosar selectat; tabelul `sampling_visit` împiedică
dublarea), fie la cerere (Dosar nou → „Verificare la fața locului”). Motivul vizitei
(`visit_reason`) se completează automat: eșantion – risc ridicat sau selecție aleatorie.

**Circuit.** Programarea vizitei (dată, loc, persoană de contact) → notificarea beneficiarului
(document generat, înregistrat la ieșire și trimis pe e-mail; numărul din Registrul verificărilor
la fața locului se alocă acum) → vizita (expertul de monitorizare: listă de verificare cu 12
puncte, constatări, rezultat, recomandări, fotografii, semnătura reprezentantului) → avizare șef
serviciu → aprobare director → comunicarea raportului → în funcție de rezultat: încheiere (conform),
urmărirea recomandărilor cu termen (conform, cu recomandări) sau sesizare automată către nereguli
(neconform: sub-flux P4, precompletat cu sursa „vizită la fața locului” și constatările). Dacă
recomandările nu sunt implementate, din urmărire se poate sesiza la fel neregula. Cel care a
efectuat vizita nu poate aviza raportul (separarea funcțiilor), iar pașii de vizită, avizare și
aprobare cer declarația privind conflictul de interese.

**Dovezi** (tabel `visit_evidence`): fotografii și semnătura reprezentantului, stocate în
depozitul adresat după conținut, cu ora de pe dispozitiv (`taken_at`), poziția GPS (latitudine,
longitudine, precizie), descrierea, autorul, pasul și amprenta SHA-256. Se acceptă doar JPEG și PNG,
recunoscute după conținut (nu după tipul declarat), maximum 15 MB. Se pot adăuga numai de cel care
are sarcina la pasul marcat `"evidence": true` și numai cât acesta este deschis. O semnătură nouă o
înlocuiește pe cea veche; ștergerile sunt logice și auditate. Fiecare dispozitiv generează un
`clientId` pentru fiecare fotografie, deci o retrimitere după o conexiune căzută nu creează dubluri.

**Validări** la trimiterea raportului: cel puțin o fotografie (`evidence.photos >= 1`), semnătura
reprezentantului (`evidence.signature`), lista de verificare completă, recomandări și termen când
rezultatul nu este „conform”, raport semnat. Valorile `evidence.*` și `today` sunt disponibile în
regulile oricărei definiții de proces.

**Raportul** (`p8_visit_report`) are atributul `appendEvidence`: la generare, după completarea
șablonului, `appendEvidenceAnnex` adaugă în DOCX o anexă cu fiecare fotografie (descriere, dată și
oră, coordonate GPS, autor, început de amprentă) și cu semnătura reprezentantului. Anexa se face pe
DOCX, deci are fonturile șablonului și apare și în PDF.

**Modulul de teren** (`/teren/:id`, pentru telefon sau tabletă):

- listă de verificare cu butoane mari Da / Nu / N/A și observații (obligatorii unde cere lista);
- fotografii direct din cameră sau din galerie, micșorate pe dispozitiv la maximum 1600 px (JPEG 0,82),
  cu poziția GPS curentă (cea mai recentă poziție de cel mult 2 minute sau o citire nouă);
- constatări, rezultat, recomandări, termen;
- semnătura reprezentantului pe ecran (degetul sau creionul) și numele lui;
- **funcționare fără semnal**: dosarul se păstrează în IndexedDB (`apps/web/src/offline.ts`), iar
  fiecare modificare intră într-o coadă locală trimisă în ordine când revine conexiunea (automat la
  evenimentul `online` și la 30 de secunde). O modificare refuzată de server rămâne vizibilă, cu
  motivul, și poate fi reîncercată sau abandonată. Aplicația se deschide fără semnal prin service
  worker (`apps/web/public/sw.js`: pagina din rețea când există, altfel copia locală; fișierele
  construite din cache), iar utilizatorul curent este reținut local până la ieșirea din cont;
- semnarea raportului și trimiterea la avizare, când există semnal.

Aplicația se poate instala pe ecranul telefonului (manifest web, `display: standalone`).

**Evidență**: pagina Vizite pe teren (`/vizite`, `GET /visits`) listează vizitele cu data
programată sau efectuată, beneficiarul, locul, inspectorul, stadiul, numărul de fotografii, semnătura
și rezultatul, cu indicatori (în curs, efectuate luna aceasta, cu recomandări, neconforme). În dosar,
fila „Fotografii și semnătură” arată galeria, cu legături la hartă pentru fiecare poziție GPS.

## 14. Nereguli și debitori

- Dosarele P4 pornesc manual sau automat din P2.
- La aprobare, acțiunea `create_debt` creează debitul (`debt`) cu titlul de creanță, scadența și
  registrul debitorilor.
- Încasările și compensările (`POST /debts/:id/payments`, tabel `debt_payment`) actualizează soldul;
  restanțele se calculează la data curentă. Pagina Debitori are export Excel.

## 15. Arhivă

- Nomenclatorul arhivistic (`archive_nomenclature_item`): indicativ, denumire, termen de păstrare.
- Dosarele de arhivă (`archive_file`) pe ani; un dosar de lucru se clasează
  (`POST /instances/:id/archive`); dosarele se închid la final de an (`/archive/files/:id/close`).
- La expirarea termenului de păstrare apar propuneri de eliminare (`GET /archive/disposal`);
  eliminarea (`/archive/files/:id/dispose`) cere decizia comisiei și avizul Arhivelor Naționale și
  se aprobă de director. Inventarul se exportă în Excel.

## 16. Colaborare, căutare, notificări

- **Comentarii** pe dosar (`/instances/:id/comments`) cu `@utilizator`: cel menționat primește
  notificare și drept de citire pe dosar.
- **Căutare globală** (`GET /search?q=`): `instance.search_text` (titlu, număr, beneficiar, valori,
  tabele, comentarii, titluri de documente), normalizat cu `unaccent`, index GIN; plus intrările
  din registre. Rezultatele respectă drepturile de acces.
- **Notificări** în aplicație (`/notifications`) și pe e-mail (prin outbox, dacă `SMTP_URL` e setat):
  sarcini noi, mențiuni, documente de semnat, termene.

## 17. Integrări

- **ANAF** (`POST /beneficiaries/lookup-anaf`): date firmă după CUI din serviciul public;
  `ANAF_MODE=mock` răspunde din date locale.
- **Import proiecte** din Excel (`POST /projects/import`), cu linii bugetare.
- **Tokenuri API** (`/admin/api-tokens`): format `flx_…`, se afișează o singură dată, se stochează
  doar SHA-256; folosire: `Authorization: Bearer flx_…`. Tokenul acționează ca utilizatorul care l-a
  creat (ex. Power BI pe `/exports/instances.xlsx` și `/dashboard`).
- **Webhook-uri** (`/admin/webhooks`): evenimente `dossier.created`, `dossier.step_completed`,
  `dossier.returned`, `dossier.finished`, `registry.entry_created`, `document.signed`,
  `debt.created`, `debt.payment_recorded`. Livrarea e un job din outbox (până la 5 încercări), corp JSON
  semnat în antetul `X-Flux-Signature` cu HMAC-SHA256 pe secretul webhook-ului.
- **E-mail primit** (`/mail`): mesajele intră prin IMAP (`IMAP_URL`, verificare la
  `MAIL_INTERVAL_MS`) sau prin încărcare `.eml` (`POST /mail/upload`). Registratura le înregistrează
  (opțional cu dosar P5), le atașează la dosarul al cărui număr apare în subiect (sugestie automată)
  sau le ignoră (`POST /mail/:id/process`). Originalul și atașamentele se păstrează cu hash.
- **Apeluri REST** din definiții (`call_rest`), executate de worker.

## 18. Securitate și acces

- **Autentificare**: utilizator + parolă (scrypt, N=2^15, r=8, p=1), opțional TOTP (secret criptat
  AES-256-GCM cu `APP_KEY`). Sesiuni pe server (`user_session`), cookie HttpOnly, SameSite,
  `Secure` în producție; durată `SESSION_HOURS`. Revocarea e imediată (ștergerea sesiunii).
- **CSRF**: orice cerere care modifică date trebuie să aibă antetul `X-Flux-Csrf: 1`; browserele nu
  îl pot trimite cross-site fără preflight CORS, pe care API-ul nu îl permite. Excepție:
  callback-ul furnizorului de semnătură. Cererile cu token Bearer nu au nevoie de antet.
- **Antete**: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: DENY`.
- **Acces la dosar** (`access/policy.ts`), o singură interogare: inițiatorul, titularii sarcinilor
  (actuale și trecute), membrii cozilor, înlocuitorii, cei cu drept explicit (`instance_acl`, ex.
  prin mențiune sau `grant_access`), și rolurile de supraveghere (`director`, `functional_admin`,
  `auditor`) care văd toate dosarele instituției. Documentele moștenesc dreptul dosarului.
- **Separarea funcțiilor** și **conflictul de interese** sunt verificate pe server la fiecare acțiune.
- **Date personale**: `processing_activity` documentează prelucrările (GDPR, registrul activităților).

## 19. Jurnalul de audit

- Fiecare schimbare scrie un eveniment în `audit_event` **în aceeași tranzacție** (fără eveniment,
  schimbarea nu se poate comite): actor, „în numele”, acțiune, entitate, valori vechi/noi, IP,
  user-agent, moment.
- Lanț de hash-uri: `hash = SHA-256(prev_hash || conținut)`; id-ul și `prev_hash` se atribuie sub
  un advisory lock, deci lanțul e corect și la scrieri concurente.
- Trigger-ul refuză UPDATE și DELETE. Verificarea: `GET /admin/audit/verify` sau
  `select * from flux.audit_verify_chain()` (zero rânduri = lanț intact).
- Jurnalul unui dosar: fila „Istoric/Audit” (`GET /instances/:id/audit`); jurnalul global în
  Administrare.

## 20. API REST

Prefix `/api/v1`, JSON, erori în format RFC 7807 (`status`, `title`, `errors[]`, `code`).
Documentația interactivă OpenAPI: `/api/docs`. Rute principale:

| Zonă | Rute |
|---|---|
| Stare | `GET /health`, `GET /ready` |
| Autentificare | `POST /auth/login`, `POST /auth/logout`, `GET /me`, `POST /me/password`, `POST /me/totp/setup`, `POST /me/totp/confirm` |
| Dosare | `GET/POST /instances`, `GET /instances/:id`, `PATCH /instances/:id/fields`, `PUT /instances/:id/lists/:key`, `PUT /instances/:id/checklists/:key/responses`, `POST /instances/:id/transitions`, `GET /instances/:id/audit`, `POST /instances/:id/access`, `POST /instances/:id/archive` |
| Sarcini | `GET /tasks`, `POST /tasks/:id/claim`, `POST /tasks/:id/reassign` |
| Documente | `GET /instances/:id/documents`, `POST /instances/:id/documents`, `POST /instances/:id/documents/:docKey/generate`, `POST /instances/:id/documents/:docKey/sign`, `GET /documents/:id`, `GET /documents/versions/:versionId/content` |
| Semnături | `GET /signatures/pending`, `POST /signatures/batch`, `GET /signatures/:id`, `POST /signatures/callback/:provider` |
| Controale | `GET/POST /instances/:id/coi`, `GET /instances/:id/double-funding`, `GET/POST /sampling`, `GET /sampling/:id`, `GET /irregularities` |
| Vizite pe teren | `POST /sampling/:id/visits`, `GET /visits`, `GET/POST /instances/:id/evidence` (multipart: `file`, `kind`, `caption`, `takenAt`, `latitude`, `longitude`, `accuracy`, `clientId`, `signerName`), `GET /instances/:id/evidence/:eid/content`, `DELETE /instances/:id/evidence/:eid` |
| Debite | `GET /debts`, `GET /debts/:id`, `POST /debts/:id/payments` |
| Registre | `GET /registers`, `GET/POST /registers/:key/entries`, `PATCH /registers/:key/entries/:id`, `GET /correspondents` |
| Arhivă | `GET /archive`, `GET/POST /archive/files`, `GET /archive/files/:id`, `POST /archive/files/:id/close`, `POST /archive/files/:id/dispose`, `GET /archive/disposal`, `POST /archive/nomenclature` |
| Colaborare | `GET/POST /instances/:id/comments`, `GET /notifications`, `POST /notifications/read`, `GET /search` |
| E-mail | `GET /mail`, `GET /mail/:id`, `GET /mail/:id/files/:index`, `POST /mail/upload`, `POST /mail/:id/process` |
| Referință | `GET /process-definitions`, `GET/POST /beneficiaries`, `POST /beneficiaries/lookup-anaf`, `GET /projects`, `GET /projects/:id`, `POST /projects/import`, `GET /nomenclatures/:key`, `GET /users` |
| Raportare | `GET /dashboard`, `GET /exports/instances.xlsx` |
| Înlocuiri | `GET/POST /substitutions`, `DELETE /substitutions/:id` |
| Administrare | `/admin/users`, `/admin/users/:id/roles`, `/admin/calendar/:year`, `/admin/deadline-definitions`, `/admin/process-definitions` (+ `validate`, versiuni, `publish`), `/admin/checklist-templates`, `/admin/document-templates`, `/admin/audit`, `/admin/audit/verify`, `/admin/api-tokens`, `/admin/webhooks`, `/admin/meta` |

Exemplu de tranziție:

```http
POST /api/v1/instances/8f1c…/transitions
X-Flux-Csrf: 1
Content-Type: application/json

{ "taskId": "1a2b…", "path": "submit", "comment": "Verificare finalizată" }
```

Răspuns la validare eșuată (422): lista exactă a ce lipsește (câmpuri obligatorii, puncte din lista
de verificare fără răspuns, documente nesemnate).

## 21. Interfața web

`apps/web` – React 19, Vite, react-router 7, TanStack Query; servită de API din `WEB_DIST`.

| Pagină | Rută | Conținut |
|---|---|---|
| Panoul meu | `/` | sarcini grupate după termen, coada comună, documente de semnat (semnare în lot), notificări |
| Dosare | `/dosare` | listă cu filtre (proces, stare, program, județ, responsabil, termen), export |
| Dosar nou | `/dosar-nou` | alegerea procesului și a proiectului, precompletare |
| Dosarul | `/dosare/:id` | bara circuitului, acțiunile pasului, file: Date, Tabel, Listă de verificare, Documente, Înregistrări, Termene, Comentarii, Flux (diagramă), Istoric; alerte CI și dublă finanțare |
| Registre | `/registre`, `/registre/:key` | intrări, căutare, conexare, export |
| Căutare | `/cautare` | căutare globală |
| Nereguli | `/nereguli` | lista neregulilor, marcaj IMS |
| Debitori | `/debitori` | sold, încasări, restanțe, export |
| Eșantionare | `/esantionare` | planuri, previzualizare, scoruri și factori, programarea vizitelor din eșantion |
| Vizite pe teren | `/vizite` | vizitele programate, în lucru și încheiate, cu indicatori |
| Modul de teren | `/teren/:id` | pagina pentru telefon: listă de verificare, fotografii cu GPS, semnătură, lucru fără semnal |
| Arhivă | `/arhiva` | nomenclator, dosare pe ani, eliminare |
| Corespondență | `/corespondenta` | coada de e-mail |
| Tablou de bord | `/tablou` | volum pe expert, termene, timp mediu pe pas, blocaje, cozi |
| Administrare | `/admin/*` | utilizatori, roluri, înlocuiri, calendar, termene, procese (JSON + diagramă + validare), liste, șabloane, import, integrări, audit |
| Contul meu | `/cont` | parolă, 2FA |

Meniul se adaptează după roluri (`can.*` în `api.ts`). Accesibilitate: HTML semantic, etichete pe
toate câmpurile, navigare cu tastatura, contrast WCAG AA.

## 22. Joburi în fundal (worker)

`apps/api/src/worker.ts`:

- **Outbox** (`job_outbox`, `FOR UPDATE SKIP LOCKED`, interval `OUTBOX_INTERVAL_MS`), tipuri:
  `generate_document`, `email_users`, `email_beneficiary`, `webhook`, `call_rest`. Joburile eșuate
  se reîncearcă cu întârziere crescătoare, de cel mult 5 ori; ultima eroare rămâne în `last_error`.
- **Termene**: scanare la `DEADLINE_INTERVAL_MS` (reamintiri, depășiri, escaladare).
- **E-mail**: citire IMAP la `MAIL_INTERVAL_MS`, doar dacă `IMAP_URL` este setat.

Se pot rula mai multe instanțe de worker; blocarea pe rând evită dubla execuție.

## 23. Configurare (variabile de mediu)

| Variabilă | Implicit | Rol |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres@127.0.0.1:5432/flux` | conexiunea PostgreSQL |
| `DB_POOL_MAX` | – | mărimea pool-ului |
| `PORT`, `HOST` | `3000`, `0.0.0.0` | ascultare API |
| `WEB_CONCURRENCY` | nr. nuclee | procese în cluster |
| `WEB_DIST` | – | directorul interfeței construite, servită de API |
| `PUBLIC_URL` | `http://localhost:5173` | adresa publică (linkuri în e-mailuri) |
| `APP_KEY` | – (obligatoriu) | 32 de octeți base64; criptarea secretelor TOTP |
| `SECURE_COOKIES` | `true` în producție | cookie doar pe HTTPS |
| `SESSION_HOURS` | `10` | durata sesiunii |
| `STORAGE_DIR` | `storage` | fișierele documentelor |
| `GOTENBERG_URL` / `SOFFICE_PATH` | – / `soffice` | conversia PDF |
| `SIGNATURE_PROVIDER` | `simulated` | furnizorul de semnătură |
| `ALLOW_SIMULATED_SIGNATURES` | – | permite semnătura simulată în producție (doar demo) |
| `DSS_URL` | – | serviciul EU DSS pentru validare |
| `ANAF_MODE`, `ANAF_URL` | `live`, serviciul public | interogarea ANAF |
| `SMTP_URL`, `MAIL_FROM` | – | trimiterea e-mailurilor |
| `IMAP_URL`, `MAIL_INTERVAL_MS` | –, `120000` | citirea e-mailurilor primite |
| `OUTBOX_INTERVAL_MS`, `DEADLINE_INTERVAL_MS` | – | intervalele workerului |
| `TZ_INSTITUTION` | `Europe/Bucharest` | „azi” pentru termene |
| `EUR_RON` | `4.97` | cursul pentru pragul IMS |
| `MIGRATE_ON_START` | – | aplicarea migrărilor la pornire |
| `USER_CACHE_MS` | – | cache-ul utilizatorului curent |
| `FLUX_TODAY` | – | fixează data curentă (doar teste/demo) |
| Instalare: `ORG_NAME`, `ORG_CUI`, `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | | creare instituție și administrator |
| Demo: `SEED_DEMO`, `SEED_SIMULATE` | `false`, `true` | date fictive; simulatorul de activitate |

Șablonul complet: `deploy/.env.example`.

## 24. Instalare, operare, backup

**Producție** (detalii în [deploy/ghid-instalare.md](../deploy/ghid-instalare.md)):

```bash
cd deploy
cp .env.example .env        # completați parolele, APP_KEY (openssl rand -base64 32), ORG_*, PUBLIC_URL
docker compose up -d        # postgres, gotenberg, api, worker
docker compose exec api pnpm db:seed     # o singură dată: instituția și administratorul
```

Un reverse proxy (nginx, IIS) face terminarea HTTPS în fața portului `HTTP_PORT`.

- **Backup**: `deploy/backup.sh` (dump PostgreSQL + arhiva `STORAGE_DIR`); **restaurare**:
  `deploy/restore.sh`. După restaurare se verifică lanțul de audit.
- **Monitorizare**: `GET /api/v1/health` (procesul trăiește), `GET /api/v1/ready` (baza răspunde);
  loguri JSON (pino) pe stdout.
- **Actualizare**: `git pull`, rebuild imagini, repornire; migrările se aplică automat.

**Dezvoltare locală**:

```bash
pnpm install
createdb flux
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/flux ANAF_MODE=mock APP_KEY=$(openssl rand -base64 32)
SEED_DEMO=true ADMIN_PASSWORD=Demo-parola-2026 pnpm db:seed
pnpm dev:api      # http://localhost:3000/api/docs
pnpm dev:worker
pnpm dev:web      # http://localhost:5173
```

**GitHub Codespaces** (demo online): `.devcontainer/` pornește PostgreSQL, Gotenberg și aplicația pe
portul 3000. `bash .devcontainer/reset-demo.sh` reface baza cu activitatea simulată;
`bash .devcontainer/run.sh` repornește aplicația. Detalii: [.devcontainer/README.md](../.devcontainer/README.md).

## 25. Date demo și simulatorul

- `seed/demo.ts`: 16 utilizatori fictivi în 7 compartimente, 9 proiecte cu linii bugetare,
  beneficiari, nomenclatorul de arhivă. Parola tuturor = `ADMIN_PASSWORD`.

  | Utilizator | Persoană | Rol |
  |---|---|---|
  | `registratura` | Ioana Pop | inspector registratură |
  | `evf1`, `evf2` | Andrei Ionescu, Maria Dumitrescu | expert verificare financiară |
  | `ei1` | Radu Constantin | expert monitorizare/tehnic |
  | `achizitii1` | Elena Stan | expert achiziții |
  | `sef.svf`, `sef.sva`, `sef.sm`, `sef.sn`, `sef.fc` | Cristina Marin, Mihai Georgescu, Laura Enache, Irina Toma, Paul Neagu | șefi de serviciu |
  | `cfpp` | Dan Popescu | control financiar preventiv |
  | `director` | Gabriela Vasile | director (vede tot) |
  | `juridic` | Ana Nistor | consilier juridic |
  | `nereguli` | Bogdan Rusu | ofițer nereguli |
  | `contabil` | Monica Dinu | contabil |
  | `auditor` | Victor Matei | auditor (citire) |
  | `admin` | – | administrator (vede tot) |

- `seed/simulate.ts` (rulat de `pnpm db:seed` când `SEED_DEMO=true`, `SEED_SIMULATE≠false` și nu
  există dosare): trece circa 70 de dosare din toate procesele **prin API-ul real**
  (`app.inject`, ca utilizatorii demo), în ordine cronologică pe ultimele 5 luni. Un planificator
  intercalează scenariile; înainte de fiecare acțiune fixează „azi” la data simulată, iar după ea
  mută momentele din toate tabelele la ora simulată și re-înlănțuiește jurnalul de audit, care
  rămâne verificabil. Include: returnări, clarificări cu termen suspendat, sub-flux P2→P4, debite
  cu încasări, acte adiționale, referate și plăți, decizii, petiții fără răspuns (termen depășit),
  comentarii cu mențiuni, e-mailuri în coadă, un plan de eșantionare cu vizitele programate din el, vizite pe teren (conforme, cu recomandări, neconforme cu sesizare P4), o înlocuire, clasări în arhivă,
  un token API. Rezultatul ultimei rulări: 346 de acțiuni, 0 eșecuri, 86 de dosare (inclusiv 16 vizite pe teren cu fotografii, semnături și toate rezultatele posibile), lanțul de audit intact.

## 26. Testare

```bash
pnpm -r typecheck
pnpm -r test                                    # pachete + API (baza din DATABASE_URL e recreată)
PGHOST=127.0.0.1 PGUSER=postgres db/tests/verify-schema.sh
pnpm --filter @flux/web build && pnpm exec playwright test
node tests/load/open-dossier.mjs http://localhost:3000 director <parola> 200 30
```

| Suită | Ce verifică |
|---|---|
| `packages/validators` (17) | CUI, IBAN, SMIS, aritmetica sumelor |
| `packages/process-schema` (13) | validarea definițiilor, regulile, operatorii de sumă |
| `packages/working-days` | zile lucrătoare, sărbători, suspendări |
| `apps/api/test/p1-end-to-end` (14) | P1 complet: precompletare, clarificări cu suspendare, listă de verificare, semnături, returnare care invalidează semnături, CFPP, aprobare, înregistrări |
| `apps/api/test/flows` | P2, P5, drepturi de acces, 2FA, tablou de bord |
| `apps/api/test/phase2` (16) | P3, P4 ca sub-flux, debite, P6 (TVA, CFPP, separare), P7, conflict de interese, dublă finanțare, eșantionare reproductibilă, căutare, comentarii, arhivă, tokenuri, webhook-uri, e-mail |
| `db/tests/verify-schema.sh` | 100 de înregistrări concurente → 1..100 fără goluri; lanț de audit sub concurență, refuz UPDATE/DELETE, detectarea alterării; imutabilitatea definițiilor |
| `tests/e2e/p1.spec.ts` | dosar P1 prin interfață cu patru utilizatori |
| `apps/api/test/visits` (7) | vizite din eșantion fără dubluri, programare, fotografii cu GPS și semnătură (doar inspectorul, idempotent, doar imagini reale), validările raportului, anexa foto în raport, urmărirea recomandărilor, sesizarea automată P4 |
| `tests/load` | deschiderea dosarului la 200 de utilizatori concurenți |

Stare la data documentului: toate testele trec (48 de teste API, 30+ de pachete, e2e). Modulul de teren a fost verificat și în browser, pe un telefon emulat cu GPS: lucru fără semnal, redeschiderea paginii fără semnal, sincronizare la revenirea semnalului, semnare și trimitere.

## 27. Extindere: cum adaugi un proces nou

1. Creați `processes/p8/process.json` (porniți de la un proces asemănător) și, dacă e cazul,
   `checklist.json`.
2. Adăugați în `seed/base.ts` rolurile, registrele, nomenclatoarele și definițiile de termen noi;
   în `seed/templates.ts` șabloanele DOCX.
3. Validați: Administrare → Procese → „Validează” (sau `POST /admin/process-definitions/validate`);
   diagrama se afișează imediat.
4. Publicați versiunea. Dosarele existente rămân pe versiunea veche.
5. Scrieți un test de integrare după modelul `apps/api/test/phase2.test.ts` (clasa `Client` din
   `helpers.ts` declară automat conflictul de interese când e cerut).

Câmpurile, pașii, regulile, termenele și documentele se configurează fără cod. Cod nou este necesar
doar pentru un tip nou de acțiune sau o integrare nouă.

## 28. Limitări cunoscute și pași următori

- Semnătura calificată reală: lipsește adaptorul pentru furnizorul ales (interfața există).
- Integrarea MySMIS2021 (import automat al cererilor): nu există încă API public; se folosește
  importul Excel.
- SSO (OIDC / Active Directory): planificat.
- Editor vizual de procese: acum JSON + diagramă + validare.
- Opțiuni de cost simplificate și asistent AI local: în analiza de piață, neimplementate.
- Modulul de teren este o aplicație web instalabilă (nu o aplicație din magazin). Ora fotografiei
  este cea a dispozitivului; poziția GPS este cea raportată de browser.
- Termenele legale configurate sunt marcate „de validat juridic” până la confirmarea instituției.
- Stocarea fișierelor e pe disc local; pentru mai multe servere este nevoie de un volum partajat
  sau de adaptorul S3.
