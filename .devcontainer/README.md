# Flux AM – demo în GitHub Codespaces

Platforma pornește singură: la prima creare durează 6–10 minute (instalare, construirea
interfeței, baza de date și simularea activității demo: circa 70 de dosare din toate tipurile, lucrate
de utilizatorii demo în ultimele 5 luni). Apoi se deschide automat în browser; dacă nu, deschideți
fila **PORTS** și apăsați pe globul de lângă **Flux AM (3000)**.

**Utilizatori demo** – parola pentru toți: `Demo-parola-2026`

| Utilizator | Rol |
|---|---|
| `registratura` | Inspector registratură (deschide și înregistrează dosare) |
| `evf1`, `evf2` | Experți verificare financiară |
| `ei1` | Expert implementare |
| `achizitii1` | Expert achiziții |
| `sef.svf`, `sef.sva`, `sef.sm` | Șefi de serviciu |
| `cfpp` | Control financiar preventiv |
| `director` | Director (vede tot, tablou de bord) |
| `auditor` | Auditor |
| `nereguli`, `sef.sn` | Ofițer și șef serviciu nereguli |
| `contabil`, `sef.fc` | Serviciul financiar-contabil |
| `juridic` | Consilier juridic |
| `admin` | Administrator funcțional (vede toate dosarele) |

**Pentru a vedea tot ce au lucrat ceilalți:** intrați ca `director` (Panoul meu cu documente de semnat,
Dosare – toate, Tablou de bord, Nereguli, Debitori, Eșantionare, Vizite pe teren, Arhivă) sau ca `admin` (în plus
Administrare: utilizatori, termene, procese cu diagrama fluxului, audit, integrări).

**Codespace creat înainte de actualizare?** În terminal rulați `bash .devcontainer/reset-demo.sh`
(3–6 minute), apoi reîncărcați pagina.

**Încercați:** `registratura` → Dosar nou → „Verificarea cererii de rambursare” → proiectul 302145 →
completați numărul, tipul și data → Înregistrează. Apoi `evf1` → cheltuieli, constatări, listă de
verificare → Documente → Semnează → Trimite. Apoi `sef.svf` și `director`.

**Vizită pe teren (pe telefon):** `ei1` → Vizite pe teren → „Pe teren” la o vizită programată (sau
deschideți pe telefon adresa portului 3000 + `/teren/...`). Completați declarația, preluați vizita,
bifați lista, faceți fotografii (cu poziție GPS), semnătura reprezentantului pe ecran, apoi
„Semnează raportul și trimite la avizare”. Pagina merge și fără semnal: modificările se trimit când
revine conexiunea. Pentru programare din eșantion: `sef.sm` → Eșantionare → planul salvat →
„Programează vizitele”.

Date fictive, semnături **simulate** (fără valoare juridică), ANAF simulat.

Pentru a da linkul altcuiva: fila PORTS → clic dreapta pe portul 3000 → Port Visibility → Public.
Codespace-ul se oprește singur după 30 de minute de inactivitate; la repornire datele rămân.
