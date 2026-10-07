# Flux AM – Faza 1: intelegere, presupuneri, intrebari deschise

Document de pornire, conform regulii de lucru din prompt (sectiunea 0): inainte de cod
rezumam ce am inteles, listam presupunerile si intrebarile deschise, apoi propunem modelul
de date si contractele API ([02-model-date.md](02-model-date.md),
[03-contracte-api.md](03-contracte-api.md)) si structura proiectului
([01-arhitectura-si-structura.md](01-arhitectura-si-structura.md)).

Sursa: *Dosar fluxuri documente ADR* (7 octombrie 2026), Partea V si Partea VII.

## 1. Ce am inteles

**Produsul.** Flux AM este un sistem vertical de management al documentelor si fluxurilor
pentru ADR-uri si alte AM/OI de fonduri europene. Nu concureaza cu WEBCON/JobRouter ca
platforma generica; vinde *circuitele interne de fonduri europene gata configurate* peste un
nucleu de flux comun. MySMIS2021 ramane sistemul oficial beneficiar <-> AM/OI; noi acoperim
ce MySMIS nu acopera: registratura, referate, avizari interne, verificari pe liste, CFPP,
decizii, registre, arhivare.

**Faza 1 (MVP, 4-6 luni)** livreaza:

| Bloc | Continut |
|---|---|
| Modulul 1 – Motor de flux | definitii JSON versionate, pasi start/uman/sistem/decizie/paralel/sub-flux/final, cai cu validari, returnare cu invalidarea semnaturilor, repartizare, automatizari pe evenimente |
| Modulul 2 – Formulare si sabloane | tipuri de campuri (inclusiv suma RON si liste de articole), matrice camp x pas, validari (CUI, IBAN, cod SMIS, intre campuri), precompletare cu sursa si data, DOCX -> PDF |
| Modulul 3 – Registratura si registre | contor atomic pe registru si an, registrul general + registre specifice, emitenti cu deduplicare, rezolutie, conexare, clasare pe nomenclatorul arhivistic, export XLSX/PDF, cautare full-text |
| Modulul 4 – Termene | calendar de zile lucratoare cu sarbatori legale, termene configurabile (calendaristice/lucratoare), suspendari cu plafon, reamintiri, escaladare, inlocuiri |
| Modulul 5 – Semnare | adaptor pentru **un** furnizor QES la distanta, PAdES, semnatari in ordine, „Documente de semnat”, validarea semnaturilor primite, nivel de semnatura pe tip de document |
| Modulul 6 – Audit, securitate | jurnal imuabil cu lant de hash-uri (inclusiv citiri sensibile), parola + 2FA, criptare, backup, GDPR, pregatire NIS2, WCAG 2.1 AA |
| Integrari | ANAF dupa CUI; API REST propriu documentat OpenAPI; export Excel/Power BI |
| Pachete | **P1** verificare cerere de rambursare/plata/prefinantare, **P2** verificare achizitii (55 puncte), **P5** registratura generala si corespondenta |
| Ecrane | Panoul meu, Lista dosare, Dosarul, Registre, Tablou de bord de baza, Administrare (editor JSON pentru procese) |

**Ce NU facem in Faza 1:** intrare pe email, OCR, adaptor MySMIS, semnare in lot, editor vizual,
P3/P4/P6/P7 (Faza 2); AI, arhiva Legea 135/2007, portal beneficiari, mobil (Faza 3).
Nu trimitem date in MySMIS, nu codificam termene legale ca fixe, nu trimitem date catre AI extern.

**Criteriile de acceptare care dicteaza designul** (le-am tinut in minte la fiecare decizie):

1. un dosar P1 complet ruleaza cap-coada intr-un test end-to-end;
2. orice actiune apare in jurnalul de audit, care nu poate fi modificat;
3. termenele se calculeaza corect in zile lucratoare, cu sarbatori si suspendari;
4. niciun utilizator nu vede sau modifica un dosar fara drept explicit;
5. instalare on-premise cu un singur `docker-compose` si un ghid de maxim 2 pagini;
6. deschiderea unui dosar sub 1 secunda la 200 de utilizatori simultani;
7. 100 de inregistrari simultane produc 100 de numere unice consecutive.

## 2. Presupuneri (le aplicam pana la raspuns contrar)

| # | Presupunere | De ce conteaza |
|---|---|---|
| A1 | **O instalare = o institutie** (on-premise sau cloud guvernamental). Modelul are totusi `organization_id` peste tot, ca sa nu blocam un SaaS ulterior. | izolare date, OUG 89/2022 |
| A2 | Faza 1 nu are beneficiari ca utilizatori; beneficiarul exista doar ca entitate de date. | autentificare externa abia in faza 3 |
| A3 | Proiectele, contractele si liniile bugetare intra in Faza 1 prin **import XLSX** + introducere manuala; adaptorul MySMIS e faza 2. | P1 are nevoie de date precompletate din prima zi |
| A4 | Semnatura calificata se face **la distanta, la furnizor**; furnizorul returneaza PDF-ul semnat PAdES. Noi nu tinem chei private. | securitate, certificare |
| A5 | Validarea semnaturilor (inclusiv PAdES B-LTA) se face cu **EU DSS** (biblioteca Comisiei Europene, LGPL) rulat ca serviciu separat in docker-compose. In Node nu exista o biblioteca matura de validare PAdES. | cerinta 8.4 |
| A6 | Toate termenele legale sunt **date de configurare** (seed), marcate `legal_status = to_validate` pana le valideaza juristul clientului. | regula „nu inventezi cerinte legale” |
| A7 | Numarul de inregistrare se aloca in aceeasi tranzactie cu inregistrarea; daca tranzactia esueaza, numarul nu se consuma (registru fara goluri). | criteriul 7 |
| A8 | UI-ul este doar in limba romana (cu diacritice), formate `1.234,56` si `07.10.2026`. | prompt, sectiunea 0 |
| A9 | Fisierele se pastreaza in stocare compatibila S3; hash-ul SHA-256 se calculeaza la incarcare si se pastreaza in baza de date. | integritate, arhivare |

## 3. Intrebari deschise

Le-am ordonat dupa cat de mult blocheaza Faza 1. Cele marcate **[blocant]** trebuie lamurite
inainte de sprintul in care intra modulul respectiv.

### Client si implementare

1. **[blocant] Care este ADR-ul pilot?** Avem nevoie de procedurile lor operationale pentru P1/P2/P5
   (pasii reali, cine avizeaza, cand intervine CFPP), de modelele de documente (nota de
   verificare, scrisoare de clarificari, notificare de autorizare) si de lista de verificare
   folosita azi.
2. Gazduire: on-premise la client, cloud guvernamental (OUG 89/2022) sau cloud comercial in UE?
   Afecteaza backup-ul offline, SSO si monitorizarea.
3. Volum estimat: numar de utilizatori, dosare P1 pe an, dimensiunea medie a unui dosar
   (pentru dimensionarea stocarii si testul de 200 de utilizatori).

### Semnatura

4. **[blocant] Furnizorul QES pentru Faza 1:** certSIGN Paperless, DigiSign, Trans Sped sau Namirial?
   Avem nevoie de acces la mediul de test si de documentatia API. Clientul are deja contract cu vreunul?
5. Institutia foloseste **sigiliu electronic calificat** pentru documentele de iesire (de ex.
   notificarea de autorizare)? Daca da, il tratam ca semnatura de tip `seal` din Faza 1.
6. Nivelul de semnatura pe tip de document: avem o decizie interna a clientului (proiectul OUG din
   aprilie 2026 ar lasa institutiei aceasta alegere)? Pana atunci: calificata pentru tot ce iese
   din institutie, avansata/simpla pentru avizele interne – configurabil.
7. Semnarea locala cu token (componenta desktop) este necesara in Faza 1 sau ajunge doar cea la distanta?
   Propunem: doar la distanta in Faza 1.

### Termene si reguli legale

8. **[blocant pentru P1] Textul consolidat OUG 133/2021**: confirmam 20 de zile lucratoare si
   plafonul de intreruperi (dosarul mentioneaza „maximum 10” si o prezentare ADR Centru cu
   „15 zile si maximum 8”). Plafonul se aplica la numarul de intreruperi, la numarul de zile
   suspendate, sau la ambele?
9. La clarificari, termenul se **suspenda** (se reia de unde a ramas) sau se **intrerupe** (reincepe
   de la zero)? Modelul suporta ambele variante; avem nevoie de regula pentru seed.
10. Termenul porneste de la data depunerii in MySMIS sau de la data inregistrarii la ADR?

### Pachete

11. **[blocant pentru P2] Continutul listei de 55 de puncte (Anexa 06)** si temeiurile legale pe
    puncte. Este acelasi model la toate ADR-urile sau fiecare are propria varianta?
12. P1: dubla verificare EVF + EI este obligatorie pentru toate programele sau configurabila pe
    program / tip de cerere? Cine decide ca e „activa”?
13. P1: CFPP intervine „unde e cazul” – care este conditia (tip cerere, program, suma)?
14. P1: avem nevoie de calculul soldului pe liniile bugetare in Faza 1 (registrul CR/CP cu sold)
    sau ajunge inregistrarea in registru?
15. P5: registrul general este unic pe institutie sau exista si registre pe departamente/puncte
    de lucru (de ex. birouri teritoriale)?

### Registratura si arhiva

16. Formatul numarului de inregistrare (de ex. `4812/07.10.2026` sau cu prefix de compartiment)?
17. Institutia are **nomenclatorul arhivistic aprobat** in format electronic? Il importam la instalare.
18. La migrare: preluam registrele existente (numarul curent pe anul in curs) dintr-un export?

### Identitate si securitate

19. Autentificarea in Faza 1: local + 2FA (TOTP) este suficient sau Active Directory / Entra este
    obligatoriu de la pilot?
20. NIS2: clientul este deja entitate notificata (OUG 155/2024)? Cine este responsabilul de securitate
    care primeste alertele?

### Licentiere si componente

21. Licenta produsului nostru: comerciala, vanduta si ca serviciu? Am exclus componentele care
    ingreuneaza acest lucru (vezi [01-arhitectura-si-structura.md](01-arhitectura-si-structura.md), sectiunea 3:
    MinIO si Redis au schimbat licentele/distributia in 2024-2025; propunem alternative).
