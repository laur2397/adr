# Flux AM — Analiză de piață și de conformitate (Faza 2)

Data: 2026-10-07. Autor: cercetare asistată (Claude), pentru echipa Flux AM.

## 0. Metodologie și limite

- Surse: căutări web (octombrie 2026). Accesul direct (fetch) la majoritatea site-urilor de produs a fost blocat de proxy-ul de rețea (webcon.com, jobrouter.com, regista.ro, sobis.ro, it.sobis.ro, irop.gov.cz). De aceea, multe afirmații se bazează pe fragmentele (snippets) din rezultatele de căutare și pe documentația indexată, nu pe citirea integrală a paginii.
- Notație: **[V]** = confirmat într-o sursă găsită în această sesiune (URL dat); **[neverificat]** = cunoaștere generală despre produs, plauzibilă, dar neconfirmată aici la sursa primară. Nu luați deciziile comerciale pe elementele [neverificat] fără verificare.
- Atenție la ambiguitatea „ADR": în legislația de arhivare electronică, „ADR" = **Autoritatea pentru Digitalizarea României** (acreditează administratori de arhivă electronică), nu Agenția pentru Dezvoltare Regională.
- Context important: în perioada 2021–2027, ADR-urile (agențiile) sunt **Autorități de Management pentru Programele Regionale** (PR 2021–2027), deci au în interior atât verificări de management, cât și plăți/CFPP, nereguli și debite — nu doar rolul de OI din 2014–2020. Aceasta schimbă prioritatea pachetelor P4 și P6 (vezi secțiunea 4b).

---

## 1. Platforme concurente — funcționalități concrete

### 1.1 WEBCON BPS (PL, low-code, puternic în administrație/enterprise)
- Designer Studio cu trei tab-uri pe flux: **Form designer, Workflow designer, Field matrix** (matrice câmp × pas — echivalentul matricei Flux AM). [V] https://docs.webcon.com/docs/2025R2/Portal/ProcessDesign , https://docs.webcon.com/docs/2025R1/Studio/
- Reguli de formular (JavaScript), vederi diferite pe utilizator/pas. [V] aceeași sursă
- **InstantChange™**: modificarea modelului de flux, a schemei de date, a formularelor și a surselor de date se aplică imediat și instanțelor în curs. [V] https://webcon.com/model-driven-and-adaptive/ (via snippet)
- Acțiuni: cicluri (cyclical actions), acțiuni declanșate, **pornire sub-flux** (Start a subworkflow). [V] https://docs.webcon.com/docs/2023R2/Studio/Action
- **Înlocuiri (substituții)** în două moduri: „lucru în numele" și „delegare de sarcini". [V] https://community.webcon.com/posts/post/substitutions-on-behalf/307
- **OCR AI recognition** ca tip de acțiune (grupul OCR & scanning). [V] https://docs.webcon.com/docs/2023R2/Studio/Action
- HOT MAILBOX (pornire flux din e-mail), aplicație mobilă, integrare semnătură (DocuSign/Autenti etc.), rapoarte/dashboard-uri, arhivare instanțe — [neverificat].

### 1.2 JobRouter (DE, platformă de digitalizare)
- Designer vizual: pași, formulare, condiții, logica pe roluri, **căi paralele, subtabele**; afișare desktop + mobil. [V] https://www.jobrouter.com/en/features (via snippet)
- **Pornire automată a proceselor prin e-mail, fișier, programare (schedule) sau cod de bare**; logică de decizie complexă; **escaladări**. [V] aceeași sursă
- Captură mobilă cu sincronizare, **e-factură structurată (ZUGFeRD/XRechnung)**, arhivare pe reguli, **gestiunea metodelor de semnătură digitală**, **clasificare AI & detectare abateri**. [V] https://www.jobrouter.com/en/modules/
- JobMind Cloud: extragere AI a datelor din facturi direct în flux. [V] https://www.jobrouter.com/en/solutions/use-cases/finance/digital-invoice-management/
- Cloud și on-prem. [V] https://www.jobrouter.com/en/jobrouter-cloud/

### 1.3 Regista (Zitec, RO) — principalul concurent local în registratură publică
- Registre de intrare/ieșire pentru organizații cu volum mare; **clasificare, distribuire și repartizare către angajați pentru avize, rezoluții, informare și soluționare**; rapoarte specifice. [V] https://startupcafe.ro/?p=1266 , https://outsourcing-today.ro/?p=7736
- Cererile primesc număr de înregistrare, sunt **redirecționate automat** către compartimente; operatorii primesc notificări și **alerte pentru termene apropiate**. [V] https://startupcafe.ro/stiri-startupcafe-20649100-companie-romaneasca-lansat-aplicatie-prin-care-vrea-reduca-timpul-pierdut-cozi-institutii-htm-1266
- SaaS în browser, backup; module **e-Guvernare (portal cetățean)** și **plăți online** (taxe, amenzi). [V] https://www.wall-street.ro/articol/IT-C-Tehnologie/243457/regista-pregateste-lansarea-modulelor-smart-city-si-e-guvernare.html
- Din nov. 2023: **certificat de semnătură electronică calificată** oferit cetățenilor prin portal; semnarea documentelor emise prin Regista. [V] https://financialintelligence.ro/regista-adauga-semnatura-electronica-calificata-pe-lista-beneficiilor-digitale-oferite-cetatenilor/
- **Registru de documente publice** afișat automat pe site-ul instituției (arhivă navigabilă — util pt. Legea 544/2001). [V] aceeași sursă
- >900 clienți (în principal primării). [V] https://outsourcing-today.ro/?p=7736
- Nu are (din ce s-a găsit) motor de flux pentru verificări de cheltuieli FE, checklisturi duble, calcule financiare — [neverificat, absența nu e dovedită].

### 1.4 DocManager (SOBIS Solutions, RO)
- „Sistem integrat de management al documentelor și arhivelor electronice" pentru instituții publice (APL, conform Legii 215/2001). [V] https://it.sobis.ro/docmanager/ , https://it.sobis.ro/management-documente/
- Registratură electronică a tuturor actelor + **circuitul actelor (cine a dat ce rezoluții)**; evidență intrări/ieșiri pe tipuri, origine, perioade; **registru petiții**, **registru audiențe**, **registru solicitări Legea 544/2001**. [V] aceleași surse (via snippet)
- Front-office pentru cetățeni (Internet/infochioșc) + back-office intranet (urbanism, audiențe etc.). [V]
- Semnătură, OCR, integrare SMIS — [neverificat].

### 1.5 ELO ECM (DE)
- **ELO Public Sector** — soluție de e-dosar (e-records) pentru autorități; respectarea obligațiilor de retenție; transfer securizat. [V] https://www.elo.com/en-ch/software/records-management.html
- **ELO Flows** (low-code) pentru fluxuri. [V] aceeași sursă
- Suită: contracte, e-mail management, records management, facturi. [V] https://www.getapp.com.au/software/2046243/elo-ecm-suite
- Folosit în SMED-uri publice în regiune (ex. Moldova — sistem de management electronic al documentelor pe platforma ELO, cu registratură, expediere, control). [V] https://storage.mtender.gov.md/get/41c2d5a1-3acc-4c74-a8fd-b23198b16947-1742979130444

### 1.6 DocuWare
- **Intelligent Indexing**: recunoaște datele-cheie și completează masca de indexare; învață din corecturi. [V] https://www.edr-software.com/en/solutions/document-management/
- **Workflow Manager** (reguli, aprobări). [V] aceeași
- **Ștampile/adnotări** fără modificarea originalului. [V] https://erpresearch.com/erp-add-ons/dms/docuware
- **Reguli automate de retenție**, audit trail, fluxuri de ștergere automată; arhivare GoBD. [V] https://start.docuware.com/en-gb/features-and-capabilities

### 1.7 M-Files
- Organizare pe **metadate** (nu pe foldere); fluxuri declanșate de condiții de metadate. [V] https://erpresearch.com/erp-add-ons/dms/m-files
- **Aino AI**: setează automat metadate, generează rezumate, răspunde la întrebări în limbaj natural pe depozit. [V] https://m-files.com/m-files-platform
- Eliminarea versiunilor duplicate; politici de retenție; retragere automată a conținutului expirat; „audit-ready". [V] https://www.m-files.com/lp/ai-powered-document-control/

### 1.8 Alfresco (Hyland)
- **Governance Services**: records management certificat **DoD 5015.02**, ISO 15489/16175, MoReq; **planuri dinamice de retenție și eliminare**; clasificare de securitate; înregistrări fizice + electronice. [V] https://docs.alfresco.com/governance-services/3.2/ , https://crestsolution.com/solutions/alfresco-digital-business-platform/records-management/
- **Process Services** (Activiti, BPMN 2.0). [V] https://crestsolution.com/solutions/alfresco-digital-business-platform/workflow-bpm

### 1.9 Camunda 8 / Flowable (motoare BPM, nu produse finite)
- Camunda 8: BPMN + **DMN** (tabele de decizie), motor Zeebe; **Operate** (monitorizare/remediere instanțe), **Tasklist** (sarcini umane), **Optimize** (analiză blocaje/durate). [V] https://docs.camunda.io/docs/8.8/components/concepts/concepts-overview/
- Flowable: BPMN + **CMMN** (case management adaptiv) + DMN; editor de cazuri. [V] https://www.flowable.com/case-management/ , https://documentation.flowable.com/latest/reactmodel/user/design/cmmn-editor
- Relevanță: ambele sunt platforme pe care un integrator ar construi un concurent; nu au registratură, checklist, calendar RO etc. „din cutie".

### 1.10 Microsoft Power Automate + SharePoint (+ Purview)
- Aprobări secvențiale/paralele, **Approvals hub** în Dataverse, cereri livrate în Teams/Outlook, audit end-to-end. [V] https://alrafayglobal.com/blog/power-automate-approval-workflows-cre-guide/
- **Etichete de retenție Purview** + flux Power Automate la final de retenție (reetichetare, mutare, ștergere, notificare). [V] https://learn.microsoft.com/en-us/purview/retention-label-flow , https://mc.merill.net/message/MC1385583
- AI Builder (extragere documente) — [neverificat în această sesiune]. Riscuri pentru ADR: rezidența datelor/licențiere M365, lipsa logicii de domeniu (termene legale RO, registre fără goluri).

### 1.11 Laserfiche
- Depozit + full-text, șabloane de metadate, **formulare electronice, workflow low-code, captură AI** (Smart Fields), captură e-mail/hârtie/audio. [V] https://www.erpresearch.com/erp-add-ons/dms/laserfiche , https://idp-software.com/vendors/laserfiche/
- **Certificare DoD 5015.2** pentru records management; cloud/on-prem/hibrid; aplicații iOS/Android. [V] aceleași surse

### 1.12 OpenText (pe scurt)
- **Extended ECM for Government**: e-dosar conform standardelor, **plan de clasificare (file plan)**, records management cu arhivare pe termen lung, colaborare, integrare SAP/O365. [V] https://www.opentext.com/assets/documents/en-US/pdf/opentext-po-extended-ecm-for-government-en.pdf
- Cost/complexitate mare; relevant doar ca reper pentru instituții centrale.

---

## 2. Sisteme de management FE în alte state membre (funcții interne)

| Sistem | Ce face relevant pentru Flux AM | Sursă |
|---|---|---|
| **PL — CST2021** (SL2021, e-Kontrole, Kontrole Krzyżowe, BK2021, SZT2021, WOD2021) | SL2021: înregistrare și **verificare cereri de plată** (avans, rambursare, decontare avans, raportare, finală), distincție **corectare vs. reparare** a cererii; certificare și cereri de plată către CE. [V] | https://punktdlaprzyrody.lasy.gov.pl/wp-content/uploads/2025/03/2.-Prezentacja_PdP_CST-SL2021.pdf , https://www.gov.pl/web/popcwsparcie/system-teleinformatyczny-w-perspektywie-finansowej-2021-2027-w-ramach-obslugi-funduszu-europejskiego-na-rozwoj-cyfrowy-2021-2027-ferc |
| PL — **e-Kontrole** | Gestionarea controalelor (inclusiv achiziții), **checklist**, informare de control pe formular predefinit, **obiecții ale beneficiarului** la informarea de control, **monitorizarea implementării recomandărilor**. [V] | https://www.gov.pl/web/popcwsparcie/system-teleinformatyczny-w-perspektywie-finansowej-2021-2027-w-ramach-obslugi-funduszu-europejskiego-na-rozwoj-cyfrowy-2021-2027-ferc |
| PL — **Kontrole Krzyżowe** | Instrument algoritmic BigData care grupează **facturi corelate** din cererile de plată pentru detectarea **dublei finanțări** (inclusiv între perioade/programe și KPO). Bună practică listată de Antifraud Knowledge Centre (CE). [V] | https://antifraud-knowledge-centre.ec.europa.eu/library-good-practices-and-case-studies/good-practices/cross-check-it-mechanism_pl , https://funduszeue.lubuskie.pl/wp-content/uploads/2023/11/ZALACZNIK-NR-4-OPIS-METODY-PROWADZENIA-KONTROLI-KRZYZOWEJ.pdf |
| **CZ — MS2021+** (IS KP21+ pentru beneficiari, CSSF21 intern) | Ciclul complet al proiectului; controale externe/la fața locului vizibile beneficiarului read-only în IS KP21+; cereri de plată; nereguli. Detaliile modulelor interne CSSF21 — **neverificat** (site-urile irop.gov.cz blocate). | https://irop.gov.cz/MS-2021 , https://irop.gov.cz/getmedia/03ec91db-eeea-4e5b-9dde-73c9628c9354/UP-Postup-vyplnovani-externich-kontrol-v-MS2021_v1_06112023.pdf.aspx?ext=.pdf |
| **IT — ReGiS** (PNRR, RGS) | Monitorizare, **contabilitate și control**, gestiunea unor procese administrative, nivel proiect/măsură/țintă/jalon; interoperabil cu bazele naționale. Checklisturi antifraudă/conflict de interese/beneficiar real — **neverificat** în detaliu. | https://www.gruppodelfino.it/documents/7898/PNRR_ReGiS.pdf , https://www.eurosportello.eu/wp-content/uploads/Brochure-Regis-Settembre-2025.pdf |
| **ES — Fondos 2020** | Plan anual de verificare cu **metodă de eșantionare justificată** și analiză de risc de fraudă; urmărirea neregulilor în procedura de certificare; **modul de control** în care se încarcă rapoartele Autorității de Audit. [V] | https://www.fondoseuropeos.hacienda.gob.es/sitios/dgfc/es-ES/cfr/ocfr/Documents/año%202017/Foro%20Madrid-Febrero/Sistemas_de_gestion_y_control_2014-2020.pdf , https://servicio.mapama.gob.es/es/pesca/temas/fondos-europeos/report_instruccion_1_2024_plandeverificacion_22022024_v3_tcm30-675271.pdf |
| **ES — CoFFEE-MRR + MINERVA** | **DACI** (declarație de absență a conflictului de interese) pentru fiecare operațiune; CoFFEE trimite NIF-urile la AEAT; **MINERVA** caută automat legături familiale/societare între decidenți și ofertanți și returnează rezultatul în CoFFEE. [V] | https://boe.es/boe/dias/2023/03/22/pdfs/BOE-A-2023-7488.pdf , https://www.euskadi.eus/contenidos/informacion/nextgeneus_pildoras/es_def/adjuntos/Pildora-VII.-Analisis-riesgo-de-conflicto-interes-Orden-55-2023-.pdf |
| **GR — ΟΠΣ (ops.gr)** | Sistem integrat unic pentru perioadele 2014–2020 și 2021–2027, logon unic, depozite de date și raportare; legea 4914/2022 reglementează verificările de management. Eșantionare/registru debitori — **neverificat**. | https://www.ops.gr/Ergorama/fileUploads/parousiaseis/02_11_2022_grafeia_ops/eisagwgh.pdf , https://www.taxheaven.gr/law/4914/2022/arthro/39 |
| **CE — SFC2021** | Cereri de plată (art. 91 CPR, 6 ferestre de depunere/an), conturi, roluri MSMA/MSAF. Nu e pentru ADR direct (îl operează MIPE/ACP), dar datele Flux AM trebuie să poată alimenta lanțul. [V] | https://sfc.ec.europa.eu/en/2021/quickguides/paymentapplication-aib |
| **CE — ARACHNE** | Data-mining + **scor de risc** pe proiecte, beneficiari, contracte, contractori (indicatori: achiziții, eligibilitate, reputație, **concentrare**, conflict de interese), îmbogățit cu Orbis/World Compliance. Alertele **nu sunt dovezi**, ci input pentru verificări. [V] | https://antifraud-knowledge-centre.ec.europa.eu/useful-tools/what-arachne_en |
| **CE/OLAF — IMS** | Raportarea neregulilor > **10.000 EUR** contribuție UE, după constatarea administrativă/judiciară primară. [V] | https://www.olaf.vlada.gov.sk/share/olaf/informacne-materialy/7095_handbook-irregularity-reporting-final.pdf |
| **RO — MySMIS2021/SMIS2021+** | Acoperă apel→depunere→evaluare→contractare→**achiziții**→implementare (**cereri de plată, cereri de rambursare**)→monitorizare, toate pe codul unic SMIS. [V] Fluxurile interne de verificare (checklist, avize, CFPP, registratură) rămân în mare parte în afara MySMIS — nișa Flux AM. | https://www.startupcafe.ro/fonduri-europene/noi-platforme-fonduri-europene-mysmis2021-smis2021-sts.htm , https://adrnordest.ro/comentariiGhid/COD170/Apel1/Anexe/Anexa%201%20-%20Instructiuni%20completare%20cerere%20finantare.pdf |

Cerințe UE transversale:
- **Art. 74(2) CPR (Reg. 2021/1060)**: verificările de management sunt **bazate pe risc**, proporționale, cu evaluare ex-ante **în scris**; includ verificări administrative ale cererilor beneficiarilor și verificări la fața locului; frecvența/acoperirea depind de tip/mărime operațiuni, beneficiari, rezultatele verificărilor/auditurilor anterioare. [V] https://aeuf.minfin.bg/upload/15110/Risk+based+management+verifications+%E2%80%93+Article+74+%282%29+CPR+2021-2027.pdf , https://interregeurope.eu/sites/default/files/2022-12/Risk%20based%20management%20verifications%20methodology.pdf
- Opțiuni simplificate de cost (SCO): verificarea se mută de pe documente justificative pe **realizări/livrabile** — necesită formulare pe unitate/livrabil, nu doar facturi. (cerință CPR art. 53; detaliile de implementare în sistemele naționale — neverificat)

---

## 3. Cerințe legale românești pe care produsul trebuie să le suporte

| Act | Ce impune produsului | Stare / sursă |
|---|---|---|
| **Legea 214/2024** (semnătură electronică, marca temporală, servicii de încredere; în vigoare din 08.10.2024) | Semnături avansate/calificate; validare; marcă temporală. Normele de aplicare (**Ordinul 102/2026**, MO 81/02.02.2026, aplicabil din 03.04.2026) au deblocat procedurile pentru prestatori. În 2026 există un proiect de OUG de modificare a Legii 214/2024 — de urmărit. | [V] https://startupcafe.ro/semnatura-digitala-in-romania-am-avut-o-lege-in-vigoare-dar-inoperabila-analiza-anis-93965 , https://www.ces.ro/newlib/PDF/proiecte/2026/EM-OUG-modif-Lg-214_2024-FINAL_29.04.2026.pdf . Ce nivel de semnătură e obligatoriu pentru acte interne ale ADR — **neverificat**, de validat juridic |
| **Legea 135/2007** (arhivare electronică) + **Ordinul ADR (Autoritatea pentru Digitalizarea României) nr. 20.717/2024** (norme tehnice: acreditare administratori arhivă, omologare sisteme) | Arhiva electronică cu valoare probatorie: semnătură/sigiliu cu validitate extinsă, metadate, administrator acreditat; registrul public al administratorilor. Recomandare: **nu** construim arhivă certificată, ci integrare/export către un administrator acreditat (ex. certSIGN acreditat 2025). | [V] https://www.certsign.ro/wp-content/uploads/2025/07/Decizie-acreditare-administrator-arhiva-CERTSIGN.pdf , https://www.austriacard.com/wp-content/uploads/2025/11/Descriere-site-Arhiva-Electronica-v3_final-RO.docx.pdf |
| **Legea 16/1996** a Arhivelor Naționale (rep. 2014), completată prin **Legea 201/2024** (care modifică și Legea 135/2007) | Nomenclator arhivistic (art. 8) cu termene de păstrare, inventare, predare-primire la depozitul arhivei, selecționare. Conținutul exact al Legii 201/2024 privind documentele native digitale — **neverificat**. | [V parțial] https://hiphi.ubbcluj.ro/Public/File/Fisa-disc_Arhivistica_2025/Fisa_Legisla%C8%9Bie-Arhivistic%C4%83_2025_RO.pdf |
| **OUG 133/2021** + **HG 829/2022** (norme metodologice, gestiunea financiară FE 2021–2027) | Circuitul cererilor de prefinanțare/plată/rambursare, termene de verificare și plată, prefinanțare, ajustări. Termenele concrete se configurează (Flux AM le marchează deja „de validat juridic"). | [V] https://www.adrbi.ro/media/4317/bibliografie_expert-plati-si-contabilitate-proiecte.pdf |
| **OUG 66/2011** (nereguli, debite) | Constatare nereguli, titluri de creanță, registrul debitorilor, recuperare, raportare (IMS > 10.000 EUR). Baza pentru P4. | [V] https://www.adrmuntenia.ro/download_file/article/1132/Buletin-informativ.pdf |
| **Ordinul SGG 600/2018** (Codul controlului intern managerial) | Comisie de monitorizare, proceduri documentate (operaționale și de sistem), registrul riscurilor, separarea atribuțiilor, circuitul documentelor, semnalarea neregularităților. Produsul ar trebui să lege fiecare definiție de proces de codul procedurii (PO) și să producă evidențe pentru autoevaluarea anuală. | [V] https://www.spitalspiridon.ro/docs/2024/Legislatie/ORDIN%20nr.%20600%20din%2020%20aprilie%202018.pdf |
| **OMFP 923/2014** (CFP preventiv propriu — norme generale), **modificat prin Ordinul MF 455/2026** (MO 409/14.05.2026, anexa 1) | Viză CFPP pe operațiuni (angajamente, ordonanțări, plăți), **registrul operațiunilor prezentate la viza CFPP**, refuz de viză motivat, posibilitatea „angajare pe propria răspundere". Necesar pentru P6. Detaliile modificărilor din 2026 — **neverificat**. | [V] https://www.fiscalitatea.ro/cadrul-general-al-operatiunilor-supuse-controlului-financiar-preventiv-modificat-de-mfp-proiect-22407/ |
| **Legea 184/2016** + sistemul **PREVENT** (ANI) | Formular de integritate în achizițiile publice, avertismente de integritate — relevant pentru verificarea achizițiilor beneficiarilor (P2): câmp/verificare „avertisment PREVENT emis?". | [V] https://hotnews.ro/68-de-cazuri-de-conflicte-de-interese-n-achizitii-publice-n-valoare-totala-de-aproape-111-milioane-de-euro-prevenite-prin-sistemul-it-al-ani-353331 |
| **OG 27/2002** (petiții) | Răspuns în **30 zile** de la înregistrare; prelungire cu max. **15 zile** de conducător. (Flux AM are deja P5.) | [V] https://www.avocatnet.ro/forum/discutie_25674/dreptul-de-petitionare.html |
| **Legea 544/2001** | Răspuns în **10 zile**, max. **30 zile** dacă solicitantul e notificat în 10 zile. (Flux AM are deja P5.) | [V] https://campulungmoldovenesc.ro/files/statice/contestareL544.pdf |
| **GDPR** | Minimizare, termene de retenție, drepturi de acces, jurnal acces la date personale (Flux AM loghează și citirile — avantaj). | general |
| **OUG 155/2024** (NIS2) | Administrația publică e sector vizat; entități esențiale/importante: înregistrare la DNSC, managementul riscurilor, **raportare incidente**, audit de securitate; amenzi mari. Produsul trebuie să susțină clientul: jurnale exportabile (SIEM), MFA, gestionare vulnerabilități, documentație de securitate. Dacă o ADR anume e încadrată — **neverificat**. | [V] https://upt.ro/img/files/legislatie/2024/OUG_155_2024.pdf |
| **OUG 112/2018** (aprobată prin Legea 90/2019) — accesibilitate | Site-uri și aplicații mobile ale organismelor publice: EN 301 549 / WCAG, **declarație de accesibilitate**. Aplicabilitatea la intranet/extranet nou — de verificat; recomandare: WCAG 2.1 AA din start. | [V] https://www.w3.org/wai/policies/romania , https://accesstive.com/compliance-hub/romania-no-112-2018/ |

---

## 4a. Matrice de funcționalități

Legendă: **D** = da, **P** = parțial/prin configurare/integrare, **N** = nu, **?** = neverificat. Valorile marcate cu `*` sunt din cunoaștere generală, [neverificat] în sesiune.

| Funcționalitate | WEBCON | JobRouter | DocuWare | M-Files | Regista | DocManager | Camunda 8 | PowerAut.+SP | **Flux AM acum** |
|---|---|---|---|---|---|---|---|---|---|
| Motor flux cu pași umani/paraleli/condiționali | D | D | D | D | P | P | D | D | **D** |
| Matrice câmp × pas | D | D* | ? | ? | N* | N* | N (cod) | N | **D** |
| Editor vizual de proces | D | D | D | D* | ? | ? | D | D | **N** (JSON) |
| Modificare la cald a instanțelor în curs | D (InstantChange) | ? | ? | ? | ? | ? | P* (migrare instanțe) | N* | **N** (versionare) |
| Sub-fluxuri | D | D* | ? | ? | ? | ? | D (call activity) | D* | **N** |
| Substituții / „în numele" | D | D* | D* | ? | ? | ? | N | P | **D** |
| Escaladare termene | D* | D | D* | ? | D (alerte) | ? | D (timere) | P | **D** |
| Calendar zile lucrătoare RO + termene legale | N* | N* | N* | N* | P* | P* | N | N | **D** |
| Registratură fără goluri, registre multiple | P* | P* | P* | P* | D | D | N | N | **D** |
| Registre petiții / 544 | N* | N* | N* | N* | D* | D | N | N | **D** (P5) |
| Pornire flux din e-mail | D* | D | D* | D* | ? | ? | P | D | **N** |
| OCR / extragere AI din documente | D | D | D | D (Aino) | ? | ? | N | P* | **N** |
| Asistent AI (rezumat, Q&A) | ? | P | ? | D | N* | N* | N | P* | **N** |
| Semnătură electronică calificată integrată | P* | D | P* | P* | D (cetățeni) | ? | N | P* | **P** (simulat + validare DSS) |
| Semnare în lot | ? | ? | ? | ? | ? | ? | N | ? | **N** |
| Retenție / plan de clasificare / eliminare | P* | D | D | D | P | D (arhivă) | N | D (Purview) | **P** (clasificare, fără retenție/eliminare) |
| Audit trail imuabil (hash chain, incl. citiri) | P* | P* | D | D | ? | ? | P | D | **D** (peste medie) |
| Portal extern / cetățean | P* | P* | P* | P* | D | D | N | P | **N** |
| Mobil | D* | D | D* | D* | ? | ? | P | D | **N** |
| Analitică de proces (durate, blocaje) | D* | D* | P* | P* | P | ? | D (Optimize) | P | **P** (dashboard) |
| SSO / AD | D* | D* | D* | D* | ? | ? | D | D | **N** |
| Checklist DA/NU/NA cu dublă verificare | P (config) | P (config) | N | P | N | N | N | P | **D** |
| Domeniu FE: cereri plată/achiziții beneficiari | N | N | N | N | N | N | N | N | **D** (P1, P2) |
| Eșantionare bazată pe risc (art. 74 CPR) | N | N | N | N | N | N | N | N | **N** |
| Nereguli + registru debitori + export IMS | N | N | N | N | N | N | N | N | **N** (P4) |
| Detectare dublă finanțare | N | N | N | N | N | N | N | N | **N** |
| Declarații conflict de interese per dosar | N | N | N | N | N | N | N | N | **N** (doar separarea atribuțiilor) |
| Integrare MySMIS2021 | N | N | N | N | N | N | N | N | **N** |
| Viză CFPP + registru CFPP | N* | N* | N* | N* | N* | ? | N | N | **N** (P6) |

Concluzie matrice: concurenții orizontali (WEBCON/JobRouter/DocuWare/M-Files) sunt mai buni la **captură (e-mail/OCR/AI), editor vizual, mobil, retenție, SSO**; concurenții locali (Regista/DocManager) sunt mai buni la **portal cetățean și arhivă**, dar niciunul nu acoperă **logica de verificare FE** (P1/P2, checklist dublu, termene OUG 133/HG 829). Diferențiatorul Flux AM este domeniul; golurile critice sunt integrarea (MySMIS, semnătură reală, SSO, e-mail) și pachetele P4/P6 care sunt în interiorul ADR ca AM.

---

## 4b. Lista prioritizată de goluri

Efort: **S** ≤ 2 săpt-dev, **M** 2–6 săpt-dev, **L** > 6 săpt-dev (estimări orientative).

### A. „Must" pentru pilotul ADR

1. **Semnătură calificată reală + semnare în lot** — Fără ea, fluxurile rămân hibride hârtie/PDF; Legea 214/2024 e operabilă din 04.2026.
   Schiță: implementare `SignatureProvider` pentru un QTSP RO cu semnare la distanță (PAdES-B-LT/LTA, marcă temporală); tabel `signature_batch(id, user, created_at, status)` + `signature_batch_item(doc_version_id, sha256, status, error)`; UI „Semnează selecția (N)" din Sarcinile mele cu un singur OTP; revalidare DSS după semnare. **M**.
2. **Import/sincronizare MySMIS2021** (cereri de plată/rambursare, achiziții, date proiect) — Beneficiarii depun deja în MySMIS (art. 69(8) CPR: nu se cere dubla depunere); fără import, experții copiază manual. Schiță: adaptor în două trepte — (1) import fișiere export MySMIS (XLSX/XML/PDF) mapate pe dosarul P1/P2 cu proveniență „MySMIS" (refolosește prefill-ul existent), (2) API când MIPE îl oferă (**neverificat** dacă există API pentru AM). Tabel `external_ref(system, external_id, dossier_id, last_sync, payload_hash)`. **M** (fișiere) / **L** (API).
3. **P4 — Nereguli și debite (OUG 66/2011) + export IMS** — ADR e AM: constatarea neregulilor, titlurile de creanță și registrul debitorilor sunt obligatorii și auditate. Schiță: proces P4 (sesizare → control → proces-verbal de constatare/notă → titlu de creanță → contestație → recuperare/compensare); entități `irregularity(id, project, type, amount_eu, amount_nat, detection_date, ims_reportable bool)`, `debt(id, irregularity_id, principal, interest_rule, due_date)`, `debt_movement(debt_id, kind, amount, doc_ref)`; raport „de raportat în IMS" (> 10.000 EUR contribuție UE); dobânzi calculate cu aritmetica monetară existentă. **L**.
4. **P6 — Notă de fundamentare, angajare, ordonanțare, plată cu viză CFPP** — Fluxul de plată către beneficiari e intern ADR; OMFP 923/2014 (mod. 2026) cere registrul operațiunilor la viza CFPP. Schiță: pas tip „viză CFPP" (persoană desemnată prin decizie, aprobat/refuz motivat, refuzul blochează, „pe propria răspundere" ca ramură separată cu aprobarea conducătorului); registru `cfpp_register` ca al 11-lea registru, numerotare fără goluri; șabloane DOCX pentru ordonanțare. **M**.
5. **Eșantionare bazată pe risc pentru verificări la fața locului (art. 74(2) CPR)** — Cerință explicită, auditată de AA; azi se face în Excel. Schiță: `risk_model(version, factors JSON, weights)`, `project_risk_score(project, model_version, score, factors_snapshot, computed_at)`; ecran „Plan de verificări" care generează eșantionul cu **seed reproductibil** salvat în audit (auditorul poate reface extragerea) + selecție manuală motivată; din eșantion se creează dosare „Vizită la fața locului". **M**.
6. **Declarații de absență a conflictului de interese per dosar** (modelul DACI spaniol, adaptat) — Cerință anti-fraudă standard; completează separarea atribuțiilor existentă. Schiță: la `claim` pe un dosar, expertul semnează declarația (șablon) față de beneficiar/furnizori; `coi_declaration(user, dossier, signed_doc_id, at)`; regula „fără declarație → nu poate prelua"; câmp în P2 „avertisment PREVENT/ANI emis". **S**.
7. **Intrare din e-mail în registratură** — Majoritatea corespondenței ADR vine pe e-mail; concurenții (JobRouter, WEBCON) o au. Schiță: poller IMAP/Graph pe căsuțe dedicate → „coș de înregistrare" (nu înregistrare automată); operatorul confirmă → număr din registru; păstrare `.eml` original + atașamente cu SHA-256; dedup corespondent existent. **M**.
8. **SSO / Active Directory (LDAP sau Entra ID/OIDC)** — Condiție tipică IT a instituției; scade suportul pentru parole. Schiță: OIDC/SAML + sincronizare grupuri AD → roluri Flux AM (maparea rămâne în Flux AM pentru separarea atribuțiilor); TOTP rămâne pentru conturi locale. **M**.
9. **Retenție și nomenclator arhivistic (Legea 16/1996, Legea 201/2024)** — Clasificarea există, lipsesc termenele de păstrare, inventarul și predarea la arhivă. Schiță: `retention_rule(class_code, years, start_event, disposition: permanent|eliminare)`; job care marchează dosarele scadente; inventar exportabil (XLSX/PDF) pentru comisia de selecționare; „legal hold" pentru dosare în control/audit. **S–M**.
10. **Conformitate accesibilitate și NIS2 (pachet minim)** — Cerință de achiziție publică previzibilă. Schiță: audit WCAG 2.1 AA (axe/pa11y în CI) + declarație de accesibilitate; export jurnale de audit/securitate în syslog/JSON pentru SIEM; procedură de raportare incidente și SBOM per release. **S**.

### B. Diferențiatori (după pilot sau în paralel, dacă există capacitate)

1. **Detectarea dublei finanțări** (după modelul polonez Kontrole Krzyżowe) — Niciun concurent DMS nu o are; AA și CE o cer insistent. Schiță: amprentă normalizată pe document justificativ `(CUI furnizor, nr. factură normalizat, dată, total)` + hash fișier, index pe toate dosarele P1 din toate programele/proiectele; alertă la verificare cu link spre dosarul suspect; potriviri parțiale (aceeași sumă/furnizor în ±30 zile). **M**.
2. **Scor de risc „red flags" de tip ARACHNE, intern** — ARACHNE dă alerte; Flux AM poate prelua exportul ARACHNE + semnale proprii (concentrare furnizori, modificări repetate de contract, termen depășit, ANAF inactiv). Schiță: tabel `red_flag(project/beneficiary/contract, source, code, severity, evidence_json)`; afișat pe pagina dosarului și alimentează modelul de eșantionare (A5). **M**.
3. **Formulare pentru opțiuni simplificate de cost (SCO)** — Verificare pe realizări (cost unitar × cantitate, rate forfetare % dintr-o bază) în loc de facturi. Schiță: tip coloană „SCO" în tabelele de linii (cost unitar din metodologia apelului, cantitate validată, rată forfetară calculată din alte linii); checklist dedicat. **S–M**.
4. **Sub-fluxuri și P3 (acte adiționale/notificări)** — P1 descoperă frecvent nevoia de act adițional sau de sesizare neregulă (P4); legarea formală mută trasabilitatea în sistem. Schiță: pas `subprocess` în JSON (proces-țintă, mapare câmpuri, așteaptă/nu așteaptă finalizarea), relația părinte-copil vizibilă pe pagina dosarului. **M**.
5. **Verificări la fața locului pe telefon/tabletă (PWA)** — Checklist offline, fotografii cu GPS și oră, semnătura reprezentantului beneficiarului, sincronizare la revenire. **M**.
6. **Extragere AI asistată din facturi/contracte** (tip JobMind/Intelligent Indexing/Aino) — Propune valori în tabelul de linii cu proveniență „AI — de confirmat"; expertul confirmă fiecare valoare (nu se aplică automat). Necesită OCR (Tesseract ron) ca prim pas. **L**.
7. **Analitică de proces** (tip Camunda Optimize) — Durata pe pas/expert, retururi, depășiri de termene, extras din jurnalul de audit; util pentru raportarea SCIM și pentru conducere. **S–M**.
8. **Legare proces ↔ procedură SCIM (OSGG 600/2018)** — Fiecare definiție de proces are cod PO, ediție/revizie, riscuri asociate din registrul riscurilor; raport anual pentru Comisia de monitorizare. **S**.

### C. Mai târziu

1. **Editor vizual de procese** — Valoare mare pentru vânzare, dar pentru pilot editorul JSON + validare ajunge; construit peste modelul existent (ex. bpmn-js doar ca vizualizare la început). **L**.
2. **Migrarea instanțelor în curs la o versiune nouă** (echivalent InstantChange) — Riscant juridic (dosare în curs pe reguli noi); de făcut doar cu mapări explicite pas→pas și aprobare. **M–L**.
3. **Arhivă electronică conform Legii 135/2007** — Nu construim arhivă acreditată; export de pachete (PDF/A + semnătură LTA + metadate + manifest SHA-256) către un administrator acreditat. **M**.
4. **Portal beneficiar** — Redundant cu MySMIS pentru cereri de plată; eventual doar pentru corespondență/petiții (P5), unde Regista/DocManager sunt deja puternice. **L**.
5. **P7 — Decizii ale directorului** — Registru de decizii + flux de avizare (juridic, CFPP) + publicare; tehnic simplu cu motorul existent. **S–M**.
6. **Asistent AI conversațional** (Q&A pe dosar/ghid) — După ce A2/B6 există și există politici de date (GDPR, rezidență). **L**.
7. **Interfață SFC2021** — Nu este responsabilitatea ADR (MIPE/ACP); doar exporturi către nivelul de program, dacă se cer. **—**.

---

## 5. Lista surselor (selecție)

- WEBCON: https://docs.webcon.com/docs/2025R2/Portal/ProcessDesign ; https://docs.webcon.com/docs/2023R2/Studio/Action ; https://community.webcon.com/posts/post/substitutions-on-behalf/307 ; https://webcon.com/model-driven-and-adaptive/
- JobRouter: https://www.jobrouter.com/en/features ; https://www.jobrouter.com/en/modules/ ; https://www.jobrouter.com/en/solutions/use-cases/finance/digital-invoice-management/
- Regista: https://startupcafe.ro/?p=1266 ; https://outsourcing-today.ro/?p=7736 ; https://financialintelligence.ro/regista-adauga-semnatura-electronica-calificata-pe-lista-beneficiilor-digitale-oferite-cetatenilor/ ; https://www.wall-street.ro/articol/IT-C-Tehnologie/243457/regista-pregateste-lansarea-modulelor-smart-city-si-e-guvernare.html
- DocManager (SOBIS): https://it.sobis.ro/docmanager/ ; https://it.sobis.ro/management-documente/
- ELO: https://www.elo.com/en-ch/software/records-management.html
- DocuWare: https://start.docuware.com/en-gb/features-and-capabilities ; https://www.edr-software.com/en/solutions/document-management/
- M-Files: https://m-files.com/m-files-platform ; https://www.m-files.com/lp/ai-powered-document-control/
- Alfresco: https://docs.alfresco.com/governance-services/3.2/
- Camunda/Flowable: https://docs.camunda.io/docs/8.8/components/concepts/concepts-overview/ ; https://www.flowable.com/case-management/
- Microsoft: https://learn.microsoft.com/en-us/purview/retention-label-flow
- Laserfiche: https://www.erpresearch.com/erp-add-ons/dms/laserfiche
- OpenText: https://www.opentext.com/assets/documents/en-US/pdf/opentext-po-extended-ecm-for-government-en.pdf
- UE/state membre: vezi tabelul din secțiunea 2.
- Legislație RO: vezi tabelul din secțiunea 3.
