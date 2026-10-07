# Flux AM – Faza 1: contracte API (propunere)

API REST sub `/api/v1`, JSON, documentat OpenAPI 3.1 (generat din cod si publicat la
`/api/docs`). Pentru UI: sesiune in cookie HttpOnly + token CSRF. Pentru integrari: token de
serviciu (`Authorization: Bearer`), cu drepturi limitate la un set de procese.

Conventii:

- erori in format `application/problem+json` cu `title` in romana, care spune ce s-a intamplat si cum se rezolva, plus `errors[]` pe campuri;
- sume ca sir zecimal `"1234.56"`, date `YYYY-MM-DD`, momente ISO 8601 cu fus orar;
- liste paginate cu `?cursor=&limit=` si raspuns `{ items, nextCursor }`;
- operatiile care schimba starea accepta `Idempotency-Key`, ca un dublu-click sa nu produca doua tranzitii sau doua numere de inregistrare;
- concurenta optimista: `GET` pe instanta intoarce `ETag`; tranzitiile si salvarile cer `If-Match` (raspuns `412` daca altcineva a modificat dosarul intre timp);
- orice raspuns `403` sau `404` pentru o instanta fara drept arata la fel (nu dezvaluim existenta dosarului).

## Identitate si administrare

| Metoda | Cale | Ce face |
|---|---|---|
| POST | `/auth/login` | utilizator + parola; raspunde `totp_required` daca 2FA e activ |
| POST | `/auth/totp` | al doilea factor |
| POST | `/auth/logout` | |
| GET | `/me` | profil, roluri active, inlocuiri active (ca titular sau inlocuitor) |
| GET/POST/PATCH | `/admin/users`, `/admin/users/{id}` | |
| GET/POST/DELETE | `/admin/users/{id}/roles` | atribuiri de rol cu perioada, departament, program |
| GET/POST/DELETE | `/substitutions` | un utilizator isi poate defini inlocuitorul; administratorul pentru oricine |
| GET/POST/PATCH | `/admin/nomenclatures/{key}/items` | |
| GET/PUT | `/admin/calendar/{year}` | sarbatori legale si zile recuperate |
| GET/POST/PATCH | `/admin/deadline-definitions` | inclusiv `POST .../{key}/validate` (marcare „validat juridic”, cu audit) |

## Definitii (Administrare)

| Metoda | Cale | Ce face |
|---|---|---|
| GET | `/process-definitions` | ultima versiune publicata pe cheie |
| POST | `/process-definitions` | creeaza un draft (JSON) |
| POST | `/process-definitions/validate` | valideaza un JSON fara sa-l salveze: schema + consistenta (cai catre pasi existenti, pasi inaccesibili, campuri inexistente) |
| PUT | `/process-definitions/{key}/versions/{v}` | modifica un draft |
| POST | `/process-definitions/{key}/versions/{v}/publish` | publica; versiunea anterioara devine `retired` |
| GET/POST | `/checklist-templates`, `/document-templates` | la fel, cu versiuni; sabloanele DOCX se incarca multipart |

## Date de referinta

| Metoda | Cale | Ce face |
|---|---|---|
| GET | `/beneficiaries?q=` | |
| POST | `/beneficiaries/lookup-anaf` | `{ cui }` -> date ANAF + `fetchedAt`; nu salveaza |
| POST | `/beneficiaries` | creeaza/actualizeaza din datele ANAF |
| GET/POST/PATCH | `/projects`, `/projects/{id}` | include liniile bugetare |
| POST | `/projects/import` | XLSX cu proiecte, contracte si linii bugetare (asumptia A3); raspuns cu raport pe randuri |

## Instante (dosare) si sarcini

| Metoda | Cale | Ce face |
|---|---|---|
| POST | `/instances` | `{ definitionKey, projectId?, beneficiaryId?, registerEntryId? }`; precompleteaza si intoarce instanta |
| GET | `/instances?definition=&status=&program=&county=&assignee=&due=overdue` | lista dosare + export `Accept: text/csv` sau `.../export.xlsx` |
| GET | `/instances/{id}` | ecranul Dosarul: antet, bara circuitului, campuri **filtrate prin matricea pasului curent**, sarcina mea, cai disponibile, termene |
| PATCH | `/instances/{id}/fields` | `{ fields: { key: value } }`; doar campurile editabile la pasul curent pentru utilizator |
| PUT | `/instances/{id}/lists/{listKey}` | inlocuieste liniile unui tabel (validari pe rand + totaluri) |
| GET | `/instances/{id}/checklists/{key}` | itemi + raspunsuri pe `verifierRole` |
| PUT | `/instances/{id}/checklists/{key}/responses` | |
| POST | `/instances/{id}/transitions` | `{ taskId, path, comment? }` -> o tranzactie: drepturi, validari, semnaturi cerute, actiuni, termene, audit. `422` cu lista exacta a ce lipseste |
| GET | `/instances/{id}/history` | pasii (cine, cand, calea, comentariu) |
| GET | `/instances/{id}/audit` | jurnalul instantei (roluri cu drept de audit) |
| POST | `/instances/{id}/access` | acord acces explicit (sef, administrator) |
| GET | `/tasks?scope=mine\|queue&due=overdue\|today\|week` | Panoul meu |
| POST | `/tasks/{id}/claim` | preia din coada comuna |
| POST | `/tasks/{id}/reassign` | sef serviciu: realocare |

## Documente si semnare

| Metoda | Cale | Ce face |
|---|---|---|
| GET | `/instances/{id}/documents` | documente cu versiuni, hash, semnaturi |
| POST | `/instances/{id}/documents` | incarcare (multipart); calculeaza SHA-256; PDF-urile semnate primite se trimit la validare |
| POST | `/instances/{id}/documents/{docKey}/generate` | (re)genereaza DOCX + PDF din sablon, versiune noua |
| GET | `/documents/{id}/versions/{v}/content` | descarcare (eveniment de audit `document.view`) |
| GET | `/signatures/pending` | „Documente de semnat” |
| POST | `/signatures/{id}/start` | porneste semnarea la furnizor; intoarce `redirectUrl` sau `challenge` (OTP/aplicatie mobila) |
| POST | `/signatures/callback/{provider}` | apel de la furnizor, autentificat (semnatura HMAC / mTLS dupa furnizor) |
| GET | `/signatures/{id}` | stare + rezultat validare |

## Registre

| Metoda | Cale | Ce face |
|---|---|---|
| GET | `/registers` | registrele vizibile utilizatorului |
| GET | `/registers/{key}/entries?year=&q=&direction=&from=&to=` | cautare full-text; export XLSX/PDF |
| POST | `/registers/{key}/entries` | inregistrare noua: aloca numarul in aceeasi tranzactie; optional porneste un proces |
| PATCH | `/registers/{key}/entries/{id}` | rezolutie, repartizare, clasare, conexare (numarul si data nu se modifica) |
| GET/POST | `/correspondents` | cu deduplicare dupa CUI / email (`409` cu inregistrarea existenta) |

## Raportare

| Metoda | Cale | Ce face |
|---|---|---|
| GET | `/dashboard?program=&from=&to=` | volum pe expert, termene respectate, timpi medii pe pas, blocaje |
| GET | `/exports/{view}` | vederi tabelare pentru Excel / Power BI (OData in Faza 2 daca e cerut) |

## Evenimente de audit (minim)

`auth.login`, `auth.login_failed`, `instance.create`, `instance.view`, `instance.field.update`,
`instance.transition`, `instance.return`, `task.claim`, `task.reassign`, `document.upload`,
`document.generate`, `document.view`, `signature.request`, `signature.complete`,
`signature.invalidate`, `register.entry.create`, `register.entry.update`, `deadline.pause`,
`deadline.resume`, `deadline.breach`, `access.grant`, `definition.publish`,
`deadline_definition.validate`, `admin.user.*`, `admin.role.*`, `substitution.*`.
