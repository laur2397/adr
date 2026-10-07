# Flux AM – ghid de instalare (on-premise)

## 1. Ce vă trebuie

- Un server Linux (Ubuntu 24.04 / Debian 12 / RHEL 9) cu 4 vCPU, 8 GB RAM, 100 GB disc (la 200 de utilizatori; documentele cresc cu circa 10–30 GB/an).
- Docker Engine 24+ cu Docker Compose.
- Un nume DNS (ex. `flux.institutie.ro`) și certificat TLS pe reverse proxy-ul instituției (nginx, Apache, Traefik) care trimite traficul către portul aplicației.
- Opțional: un server SMTP pentru notificări pe e-mail.

## 2. Instalare (15 minute)

```bash
git clone <depozit> /opt/flux-am && cd /opt/flux-am/deploy
cp .env.example .env
nano .env        # completați POSTGRES_PASSWORD, APP_KEY, ORG_NAME, ORG_CUI, ADMIN_PASSWORD, PUBLIC_URL
docker compose build
docker compose up -d
docker compose run --rm seed     # o singură dată: instituție, administrator, roluri, registre, termene, procese
```

Aplicația ascultă pe `HTTP_PORT` (implicit 8080). Configurați reverse proxy-ul cu HTTPS către `http://server:8080`.
Verificare: `curl http://localhost:8080/api/v1/ready` răspunde `{"status":"ready"}`.

Generați secretele cu `openssl rand -base64 24` (parola bazei de date) și `openssl rand -base64 32` (APP_KEY).
**Păstrați APP_KEY împreună cu backup-urile**: fără el, secretele de autentificare în doi pași nu pot fi citite.

## 3. Primii pași în aplicație (administrator funcțional)

1. Intrați cu utilizatorul `admin`, schimbați parola și activați 2FA (Contul meu).
2. **Administrare → Utilizatori**: creați utilizatorii, atribuiți rolurile (registratură, EVF, EI, achiziții, șef serviciu, director, CFPP, juridic, auditor) și departamentele; setați șeful fiecărui departament.
3. **Administrare → Calendar**: verificați sărbătorile legale propuse pentru anul curent și salvați.
4. **Administrare → Termene**: consilierul juridic verifică fiecare termen și apasă „Validează”.
5. **Administrare → Liste de verificare / Șabloane**: înlocuiți modelele cu documentele instituției.
6. **Administrare → Import proiecte**: încărcați proiectele, contractele și liniile bugetare (XLSX).

## 4. Semnătura electronică

`SIGNATURE_PROVIDER=simulated` aplică o ștampilă „SIMULARE – fără valoare juridică” și este refuzat în producție.
Pentru un pilot, `ALLOW_SIMULATED_SIGNATURES=true` îl permite explicit. Adaptorul pentru furnizorul calificat ales (certSIGN, DigiSign, Trans Sped sau Namirial) se configurează după semnarea contractului cu furnizorul.
Validarea semnăturilor din documentele primite folosește un serviciu EU DSS (`DSS_URL`), opțional.

## 5. Backup și restaurare

- Zilnic (cron): `cd /opt/flux-am/deploy && ./backup.sh` → `backups/` conține baza de date, documentele și sumele SHA-256.
- Copiați periodic `backups/` și fișierul `.env` pe un suport offline.
- Restaurare: `./restore.sh <data-ora>` (ex. `./restore.sh 20261007-013000`), apoi **Administrare → Audit → Verifică lanțul**.
- Testați restaurarea pe un server de test cel puțin o dată pe trimestru.

## 6. Actualizare

```bash
cd /opt/flux-am && git pull && cd deploy
./backup.sh
docker compose build && docker compose up -d     # migrările bazei de date rulează automat la pornire
docker compose run --rm seed                      # publică versiunile noi ale proceselor (dosarele în curs rămân pe versiunea lor)
```

## 7. Operare

- Jurnale: `docker compose logs -f api worker`. Stare: `GET /api/v1/health` (proces) și `/api/v1/ready` (bază de date).
- Documentația API (OpenAPI): `https://<server>/api/docs`.
- Imagini din registru intern: setați `POSTGRES_IMAGE` și `GOTENBERG_IMAGE` în `.env`.
- Performanță: `WEB_CONCURRENCY` (implicit un proces API pe nucleu, maxim 4); test de încărcare în `tests/load/`.
