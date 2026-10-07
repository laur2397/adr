# Flux AM – extinderea după analiza de piață

Ce s-a construit pe baza [analizei de piață](analiza-piata.md). Prioritățile urmează lista
„obligatoriu pentru pilotul ADR” și „diferențiatori”.

## Pachete de procese noi

| Pachet | Ce acoperă | Elemente notabile |
|---|---|---|
| **P3** Acte adiționale și notificări | solicitare → analiză tehnică și financiară → aviz juridic (doar pentru act adițional) → avizare → aprobare | decizie automată act adițional / notificare; după aprobare se actualizează contractul (data de finalizare, valoarea eligibilă) și se înregistrează în registrul actelor adiționale |
| **P4** Nereguli și debitori | sesizare → verificare și proces-verbal de constatare → avizare → aprobare → titlu de creanță | registrul debitorilor cu încasări și compensări, sold, restanțe, export Excel; lista neregulilor de raportat în IMS (≥ 10.000 EUR sau marcate manual) |
| **P6** Referat de necesitate și ordonanțare | referat cu TVA calculat exact → aprobare → viză CFPP angajament → aprobare angajare → recepție și factură → ordonanțare → viză CFPP plată → aprobare plată → ordin de plată | factura nu poate depăși angajamentul; cel care întocmește nu poate acorda viza CFPP; registrul vizelor CFPP, al referatelor și al ordonanțărilor |
| **P7** Decizii ale directorului | proiect → aviz șef compartiment → aviz de legalitate → semnare → comunicare | numărul deciziei se alocă înainte de semnare și se păstrează la returnare |

## Motorul de flux

- **Sub-fluxuri**: un pas poate porni un dosar-copil și aștepta rezultatul (cu câmpuri transmise în ambele sensuri), sau îl poate porni fără să aștepte. Exemplu activ: o verificare de achiziție aprobată cu corecție financiară deschide automat un dosar de nereguli P4, precompletat și repartizat ofițerului de nereguli.
- Acțiuni noi: emiterea titlului de creanță, actualizarea datelor contractului, înregistrare „o singură dată”, înmulțirea exactă a sumelor (cantitate × preț, TVA).

## Controale cerute de verificările de management (art. 74 din Reg. 2021/1060)

- **Conflict de interese**: pe pașii configurați, verificatorul semnează o declarație pe propria răspundere înainte de a lucra la dosar. Dacă declară conflict, sarcina revine în coadă și șeful de serviciu este anunțat.
- **Dubla finanțare**: fiecare factură din tabelul de cheltuieli (CUI furnizor + număr normalizat) este comparată cu toate celelalte dosare, din orice proiect sau program. Alertele apar în dosar.
- **Eșantionare pe bază de risc** pentru verificările la fața locului: scor de risc (valoare, sume neeligibile, nereguli anterioare, alerte de dublă finanțare, beneficiar nou), dosarele cu risc ridicat intră automat, restul aleator ponderat. Sămânța și selecția se păstrează și se auditează, deci eșantionul poate fi reprodus.

## Colaborare și regăsire

- **Comentarii** pe dosar cu @mențiuni: colegul menționat primește notificare și drept de citire.
- **Căutare globală** în dosare (titlu, număr, beneficiar, valorile câmpurilor, tabele, comentarii, titlurile documentelor) și în registre, respectând drepturile de acces.
- **Semnare în lot** din Panoul meu.
- **Diagrama procesului** (fila „Flux” din dosar și editorul de procese din Administrare).

## Arhivă, e-mail, integrări

- **Arhiva**: nomenclator, dosare pe ani, clasarea unui dosar, închiderea la final de an, inventar Excel, propuneri de eliminare la expirarea termenului de păstrare, aprobate de director cu decizia comisiei și avizul Arhivelor Naționale.
- **Corespondență pe e-mail**: mesajele (citite prin IMAP sau importate ca .eml) intră într-o coadă. Registratura le înregistrează (opțional cu dosar de corespondență), le atașează la dosarul al cărui număr apare în subiect, sau le ignoră. Mesajul original și atașamentele se păstrează cu hash.
- **Tokenuri API** (Power BI, alte sisteme) și **webhook-uri** semnate HMAC-SHA256 pentru evenimentele principale.

## Date demo

`SEED_DEMO=true` rulează un simulator care trece prin API-ul real circa 70 de dosare din toate tipurile, lucrate de utilizatorii demo în ultimele 5 luni, în ordine cronologică (numere de înregistrare consecutive, termene calculate la datele simulate). Dosarele începute recent sau „blocate” rămân la diverse etape: la director (documente de semnat în lot), la șefi, la experți, petiții fără răspuns cu termen depășit. Momentele acțiunilor sunt mutate la datele simulate, iar jurnalul de audit este re-înlănțuit; verificarea lanțului rămâne validă. Simulatorul este doar pentru demonstrații.

## Ce rămâne din analiza de piață

- semnătura calificată reală prin furnizor (adaptor) și importul din MySMIS2021;
- SSO (OIDC / Active Directory);
- formulare pentru opțiuni de cost simplificate, aplicația mobilă pentru vizite pe teren, asistent AI local la verificare;
- editor vizual de procese (acum: JSON cu diagramă și validare).
