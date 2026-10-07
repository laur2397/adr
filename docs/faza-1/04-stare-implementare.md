# Flux AM – Faza 1: starea implementării

Ce este construit și testat, ce depinde încă de răspunsurile din
[00-intelegere-si-intrebari.md](00-intelegere-si-intrebari.md) și ce rămâne.

## Criteriile generale de acceptare (prompt, secțiunea 15)

| # | Criteriu | Stare | Dovada |
|---|---|---|---|
| 1 | Dosar P1 complet cap-coadă cu documente generate, semnate, înregistrate | **îndeplinit** (semnătură simulată) | `apps/api/test/p1-end-to-end.test.ts` (API, 14 pași) și `tests/e2e/p1.spec.ts` (prin interfață, 4 utilizatori) |
| 2 | Orice acțiune în jurnalul de audit, nemodificabil | **îndeplinit** | triggere append-only, lanț SHA-256 cu id alocat sub lock; `db/tests/verify-schema.sh`; verificare din Administrare → Audit; restaurarea din backup păstrează lanțul (verificat) |
| 3 | Termene corecte în zile lucrătoare, cu sărbători și suspendări | **îndeplinit** | `packages/working-days` (17 teste: Paști ortodox, Crăciun, suspendare de 4 zile → +4 zile lucrătoare); `test/flows.test.ts` |
| 4 | Fără drept explicit nu se vede/modifică un dosar | **îndeplinit** | `instance_acl`; 404 identic pentru „nu există” și „nu aveți acces”; test pe dosar, listă și descărcarea documentelor |
| 5 | Instalare cu un singur docker-compose și ghid de max. 2 pagini | **îndeplinit** | `deploy/docker-compose.yml`, `deploy/ghid-instalare.md`; imaginea, seed-ul, worker-ul și Gotenberg verificate în containere (imaginea `postgres:16` nu a putut fi descărcată în mediul de test din cauza limitei Docker Hub; s-a folosit PostgreSQL 16 local) |
| 6 | Deschiderea unui dosar sub 1 s la 200 de utilizatori simultani | **îndeplinit pe hardware modest** | `tests/load/open-dossier.mjs`: 200 de sesiuni care deschid dosare continuu, fără pauză, pe 4 vCPU împărțite cu generatorul de trafic: p50 0,60 s, **p95 0,83 s**, p99 1,09 s, 0 erori (327 cereri/s). Cu o pauză medie de 2 s între deschideri: p50 0,01 s, p95 0,34 s |

## Module

| Modul | Implementat | Lipsește / depinde de răspunsuri |
|---|---|---|
| 1. Motor de flux | definiții JSON versionate și imuabile; pași start/uman/sistem/decizie/paralel (all/any)/final; căi cu condiții, validări, comentariu obligatoriu, semnături cerute; returnare cu invalidarea semnăturilor; repartizare (rol, expertul proiectului, persoana anterioară, șeful departamentului, cel mai puțin încărcat, aleasă de pasul anterior); separarea funcțiilor; automatizări (înregistrare, generare document, notificare, drepturi, suspendare/reluare termen, actualizare linii bugetare, apel REST); preluare din coadă, realocare | sub-fluxuri (faza 2); declanșatoare la timp/ciclice pe pas; editor vizual (faza 2) |
| 2. Formulare și șabloane | tipuri de câmp, matrice câmp × pas aplicată în API, validări CUI/IBAN/SMIS/intervale/reguli între câmpuri, liste de articole cu coloane calculate și totaluri, sume exacte (BigInt), precompletare cu sursă și dată, DOCX → PDF, versiune + SHA-256 | editor de formulare în interfață (acum: JSON) |
| 3. Registratură și registre | 10 registre, contor atomic fără goluri, format configurabil, emitenți deduplicați, conexare, rezoluție, clasare pe nomenclatorul arhivistic, căutare full-text, export XLSX | export PDF al registrului; intrare pe e-mail și MySMIS (faza 2) |
| 4. Termene și notificări | calendar cu sărbători (propunere calculată, editabilă), termene configurabile marcate „de validat juridic”, suspendare/întrerupere cu plafoane, refuz + notificarea șefului la depășirea plafonului, semafor, reamintiri și escaladare (worker), înlocuiri | prelungirea termenului (OG 27) din interfață |
| 5. Semnare | interfață `SignatureProvider`, semnatari în ordine, „Documente de semnat”, regenerare automată dacă datele s-au schimbat, invalidare la modificare/returnare, validarea PDF-urilor semnate primite prin EU DSS (opțional) | **adaptorul real QES** (întrebarea 4); semnare în lot (faza 2); PAdES B-LTA depinde de furnizor |
| 6. Audit, securitate | jurnal imuabil cu lanț de hash-uri (inclusiv vizualizări și descărcări), parolă + TOTP, sesiuni revocabile, CSRF, antete de securitate, fișiere verificate la fiecare citire, backup/restaurare | SSO OIDC / Active Directory (întrebarea 19); criptarea fișierelor la repaus (se recomandă la nivel de volum); registrul GDPR în interfață |
| Integrări | ANAF după CUI (live sau mock), import XLSX proiecte/contracte/linii bugetare, export XLSX, OpenAPI | adaptor MySMIS (faza 2), e-mail IMAP (faza 2) |
| Pachete | **P1**, **P2** (listă model de 12 puncte), **P5** (corespondență, petiții, Legea 544) | lista oficială de 55 de puncte (întrebarea 11); procedurile și șabloanele ADR-ului pilot (întrebarea 1) |
| Interfață | Panoul meu, Dosare, Dosar nou, Dosarul (circuit, acțiuni, formular, listă de verificare, documente, termene, istoric, înregistrări, audit), Registre, Tablou de bord, Administrare, Cont | audit formal WCAG 2.1 AA (structura e semantică, cu etichete, focus vizibil, navigare din tastatură) |

## Decizii luate la implementare (diferite de documentul 01)

- **Fastify + `pg`** în loc de NestJS + Kysely: mai puțin cod de infrastructură; SQL-ul critic (numerotare, audit, blocări) e explicit.
- **Outbox propriu pe PostgreSQL** în loc de pg-boss: jobul se scrie în aceeași tranzacție cu schimbarea.
- **Gotenberg** pentru PDF în docker-compose: imaginea aplicației rămâne mică; `soffice` local rămâne posibil.
- **Hash-uri de parolă scrypt** (biblioteca standard Node) în loc de argon2: fără module native de compilat la instalare.
- Câmpurile calculate sunt **salvate** după fiecare modificare, ca rapoartele și șabloanele să citească aceleași valori pe care le-a văzut utilizatorul.

## Defecte găsite de teste și corectate

- deduplicarea emitenților avea o cursă la înregistrări simultane (rezolvat cu `insert … on conflict`);
- notificarea șefului la refuzul unei suspendări se pierdea în rollback (acțiuni `onRollback`);
- cererea de clarificări cerea constatările finale ale expertului (opțiunea `validateFields: false` pe cale);
- un câmp calculat pe valori goale producea eroare 500;
- id-urile din jurnalul de audit nu urmau ordinea lanțului la scrieri simultane;
- șeful de serviciu se alegea după ultima persoană care închidea o ramură paralelă, nu după expertul care a întocmit nota.
