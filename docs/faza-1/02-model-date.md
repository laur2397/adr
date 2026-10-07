# Flux AM – Faza 1: modelul de date

Schema completa (PostgreSQL 16, verificata prin incarcare): [`db/migrations/0001_schema.sql`](../../db/migrations/0001_schema.sql).
Aici explicam gruparea, maparea pe entitatile din prompt si deciziile care nu se vad din SQL.

## 1. Maparea pe entitatile cerute (prompt, sectiunea 3)

| Entitate din prompt | Tabel(e) | Observatii |
|---|---|---|
| Organizatie, Departament, Utilizator | `organization`, `department`, `app_user` | departamente ierarhice, sef de departament (pentru regula `department_head`) |
| Rol, AtribuireRol (cu perioada) | `role`, `role_assignment` | rolul poate fi limitat la departament si/sau program, cu `valid_from`/`valid_to` |
| Inlocuire | `substitution` | `scope = tasks` (doar sarcinile) sau `full` (drepturi complete), optional pe un singur proces |
| Program, Prioritate, Apel | `program`, `priority`, `call_for_proposals` | |
| Beneficiar | `beneficiary` | campurile ANAF + `anaf_fetched_at` + raspunsul brut `anaf_payload` |
| Proiect | `project`, `project_budget_line` | contractul de finantare este in `project` (relatie 1:1 in practica); liniile bugetare au `approved_to_date` pentru sold |
| DefinitieProces, Pas, Cale, Conditie, MatriceCampuri | `process_definition.definition` (JSONB) | o definitie = un document JSON validat cu [JSON Schema](../../packages/process-schema/process-definition.schema.json); pasii nu sunt tabele separate, ca versiunea sa fie atomica si imuabila |
| DefinitieTermen | `deadline_definition` | tabel separat: termenele legale se configureaza si se valideaza juridic independent de procese |
| Instanta | `instance`, `execution` | `execution` = ramura activa (necesar pentru pasi paraleli) |
| Sarcina | `task` | titular sau coada pe rol/departament; `completed_by` + `on_behalf_of` pentru inlocuiri |
| Formular / ValoareCamp | `instance_field` | o valoare pe camp, cu `source` si `source_at` (cerinta de precompletare) |
| ListaArticole | `instance_list_row` | o linie = un rand JSONB, tipurile sunt validate dupa definitia campului |
| ListaVerificare, RaspunsVerificare | `checklist_template`, `checklist_item`, `checklist_response` | raspunsurile au `verifier_role` (primary/second) pentru dubla verificare EVF + EI |
| Document, SablonDocument | `document`, `document_version`, `document_template` | continutul unei versiuni e imuabil (trigger); hash SHA-256 obligatoriu |
| Semnatura | `signature` | o cerere de semnare si rezultatul ei in acelasi rand; returnarea o marcheaza `invalidated` |
| Registru, InregistrareRegistru | `register`, `register_counter`, `register_entry`, `correspondent` | contor separat pe an |
| Dosar / NomenclatorArhivistic | `archive_nomenclature_item`, `archive_file` | `retention_years = null` inseamna permanent |
| EvenimentAudit | `audit_event` | append-only, lant de hash-uri |
| Notificare, CalendarZileLucratoare | `notification`, `holiday`, `working_day_exception` | |
| (adaugate) | `step_history`, `instance_acl`, `job_outbox`, `deadline`, `deadline_pause`, `user_session`, `nomenclature*`, `processing_activity` | vezi mai jos |

## 2. Decizii de model

### 2.1 Definitia de proces ca JSON, instantele ca tabele

Definitia este o singura valoare JSONB versionata (`key`, `version`), publicata o data si apoi
imuabila (trigger `process_definition_immutable`; un singur `published` pe cheie prin index
unic partial). Instanta pastreaza `definition_id`, deci ruleaza pana la capat pe versiunea cu
care a pornit. Starea la executie (instante, ramuri, sarcini, valori) este relationala, ca sa
putem interoga eficient „sarcinile mele”, „dosarele cu termen depasit” etc.

Exemplul complet pentru P1: [`processes/p1/process.json`](../../processes/p1/process.json)
(trece validarea JSON Schema si verificarile de consistenta: toate caile duc la pasi existenti,
toti pasii sunt accesibili, campurile din matrice exista).

### 2.2 Valori de formular cu provenienta

`instance_field(instance_id, field_key, value, source, source_at)`. La pornirea instantei,
motorul citeste `prefill` din definitie si scrie valoarea cu sursa ei (`project`, `beneficiary`,
`anaf`, `previous_instance`...). Daca utilizatorul modifica o valoare precompletata, sursa devine
`manual`, iar valoarea veche ramane in audit. Sumele sunt stocate in JSON ca **sir zecimal**
(`"1234.56"`), nu ca numar, ca sa evitam rotunjirile; conversia la `numeric` se face in validari
si rapoarte.

### 2.3 Dubla verificare si liste de verificare

Sablonul de lista e versionat ca si procesul. Raspunsurile sunt pe
`(instance, item, verifier_role)`, deci EVF si EI completeaza fiecare propria lista pe acelasi
dosar; nota de verificare le poate afisa alaturat.

### 2.4 Registre fara goluri (criteriul „100 de inregistrari simultane”)

`next_register_number(register_id, year)` face `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
pe `register_counter`. Randul contorului ramane blocat pana la commit-ul tranzactiei care a cerut
numarul, deci:

- doua tranzactii simultane nu pot primi acelasi numar;
- daca inregistrarea esueaza (rollback), numarul nu se consuma.

Verificat local: 100 de tranzactii paralele + o tranzactie anulata + inca o inregistrare au
produs 101 numere, de la 1 la 101, fara duplicate sau goluri. Costul: inregistrarile in acelasi
registru se serializeaza pe durata tranzactiei, deci tranzactia de inregistrare trebuie tinuta
scurta (fara generare PDF sau apeluri externe in ea – acestea pleaca prin `job_outbox`).

### 2.5 Termene

Configurarea (`deadline_definition`) este separata de executie (`deadline`, `deadline_pause`).
La fiecare suspendare/reluare se recalculeaza `due_on` cu biblioteca `packages/working-days`
(sarbatori din `holiday`, zile lucratoare recuperate din `working_day_exception`). `pause_mode`
acopera ambele interpretari juridice posibile (suspendare cu reluare vs. intrerupere cu
repornire) – vezi intrebarea 9. Plafoanele (`max_pauses`, `max_paused_days`) se verifica la
cererea de suspendare: depasirea blocheaza actiunea si notifica seful (criteriul de acceptare 4.6).

Seed-ul contine termenele din prompt, toate cu `legal_status = 'to_validate'`, iar UI-ul le
afiseaza cu eticheta „de validat juridic” pana la validare.

### 2.6 Audit imuabil

`audit_event` are trei protectii:

1. triggere care refuza `UPDATE`, `DELETE` si `TRUNCATE`;
2. rolul de baza de date al aplicatiei primeste pe aceasta tabela doar `INSERT, SELECT` (se configureaza in prima migrare);
3. fiecare rand contine `hash = sha256(prev_hash | continut)`. Insert-urile sunt serializate cu un
   advisory lock, iar id-ul se aloca **sub lock**, deci ordinea id-urilor coincide cu ordinea din lant.

`audit_verify_chain()` intoarce primul rand cu legatura rupta. Verificat local: 160 de
evenimente scrise concurent dau un lant valid; modificarea unui rand ocolind triggerele (ca
superuser) este detectata exact la randul modificat. Pentru protectie si fata de un
administrator de baza de date, ultimul hash se exporta zilnic in afara bazei (de ex. in jurnalul
sistemului sau semnat cu sigiliul institutiei) – propunere pentru Faza 1, de confirmat.

Volum: o citire de dosar sensibil = un eveniment. Estimare la 200 de utilizatori: sub 1 milion
de randuri pe an; tabela se partitioneaza pe an daca va fi nevoie.

### 2.7 Drepturi pe dosar

Regula de baza este „implicit fara acces”. Un utilizator vede o instanta daca exista un rand in
`instance_acl` pentru el, pentru unul din rolurile lui active sau pentru departamentul lui.
Motorul adauga automat randuri cand cineva primeste o sarcina (`reason = assignee`); rolurile
de supraveghere (sef serviciu, director, auditor) primesc acces pe proces prin definitie.
Drepturile pe camp (matricea camp x pas) se aplica in API, la citire si la scriere, nu doar in UI.

### 2.8 Semnaturi si returnari

Un rand `signature` este creat cand fluxul cere semnatura (`pending`), devine `signed` cand
furnizorul intoarce PDF-ul semnat (salvat ca **versiune noua** a documentului,
`signed_version_id`). La returnarea catre pasul X, toate semnaturile cu `step_key` de la X
incolo devin `invalidated` cu motiv, iar documentul se regenereaza ca versiune noua.

## 3. Ce ramane deschis in model

- Daca o instalare va servi mai multe institutii (SaaS), adaugam Row Level Security pe
  `organization_id`; coloana exista deja peste tot.
- Registrul CR/CP cu sold pe linii bugetare depinde de raspunsul la intrebarea 14.
- Nomenclatorul arhivistic si formatul numarului de inregistrare depind de clientul pilot
  (intrebarile 16-17).
