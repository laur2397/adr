# Flux AM

[![Deschide în GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/laur2397/adr?quickstart=1)

**Vezi platforma online:** apăsați butonul de mai sus → „Create codespace”. După 3–5 minute
aplicația se deschide în browser, cu date demo; utilizatori și parolă în
[.devcontainer/README.md](.devcontainer/README.md).

Sistem de management electronic al documentelor și fluxurilor pentru Agențiile pentru Dezvoltare
Regională (ADR) și alte Autorități de Management / Organisme Intermediare pentru fonduri europene:
registratură, circuite interne de verificare și avizare (cereri de rambursare/plată, achiziții,
corespondență), documente generate din șabloane, semnare electronică, termene legale și audit.

**Stare:** Faza 1 (MVP) implementată și testată, cu semnătură simulată până la alegerea
furnizorului calificat. Detalii: [docs/faza-1/04-stare-implementare.md](docs/faza-1/04-stare-implementare.md).

## Ce face

- **Circuite gata configurate**: P1 verificarea cererii de rambursare / plată / prefinanțare,
  P2 verificarea dosarului de achiziție, P5 registratură generală și corespondență (petiții, Legea 544).
- **Dosarul**: bara circuitului, sarcina curentă cu acțiunile posibile, formular precompletat din
  proiect, beneficiar (ANAF) și dosarul anterior, tabel de cheltuieli cu sume exacte, listă de
  verificare (inclusiv dubla verificare EVF + EI), documente generate DOCX/PDF, semnături în ordine,
  termene cu semafor, istoric și jurnal de audit.
- **Registre** cu numerotare atomică fără goluri, emitenți deduplicați, conexare, export Excel.
- **Termene** în zile lucrătoare cu sărbătorile legale, suspendări la clarificări cu plafon,
  reamintiri și escaladare, toate configurabile și marcate „de validat juridic”.
- **Securitate**: drepturi explicite pe dosar, separarea funcțiilor, înlocuiri în concediu
  („în numele”), 2FA, jurnal de audit append-only cu lanț de hash-uri.
- **Administrare**: utilizatori și roluri, calendar, termene, definiții de proces (JSON, versionate),
  liste de verificare, șabloane DOCX, import de proiecte din Excel, tablou de bord pentru conducere.

## Pornire pentru dezvoltare

Necesar: Node 22, pnpm 10, PostgreSQL 16 și LibreOffice (`soffice`) sau un container
[Gotenberg](https://gotenberg.dev) (`GOTENBERG_URL`) pentru PDF.

```bash
pnpm install
createdb flux
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/flux ANAF_MODE=mock APP_KEY=$(openssl rand -base64 32)
SEED_DEMO=true ADMIN_PASSWORD=Demo-parola-2026 pnpm db:seed   # migrări + instituție demo
pnpm dev:api        # http://localhost:3000/api/docs
pnpm dev:worker     # joburi și termene
pnpm dev:web        # http://localhost:5173
```

Utilizatori demo (parola din `ADMIN_PASSWORD`): `registratura`, `evf1`, `evf2`, `ei1`,
`achizitii1`, `sef.svf`, `sef.sva`, `sef.sm`, `cfpp`, `director`, `juridic`, `auditor`, `admin`.
Instituția, persoanele, beneficiarii și proiectele demo sunt fictive.

## Teste

```bash
pnpm -r typecheck
pnpm -r test                                  # unitare + integrare pe PostgreSQL (baza flux_test)
PGHOST=127.0.0.1 PGUSER=postgres db/tests/verify-schema.sh
pnpm --filter @flux/web build && pnpm exec playwright test   # dosar P1 prin interfață
node tests/load/open-dossier.mjs http://localhost:3000 director <parola> 200 30
```

## Instalare la client

`deploy/`: un singur `docker-compose.yml` (PostgreSQL, Gotenberg, aplicație, worker),
`.env.example`, scripturi de backup/restaurare și [ghidul de instalare](deploy/ghid-instalare.md).

## Documentație

| Document | Conținut |
|---|---|
| [00 – Înțelegere și întrebări](docs/faza-1/00-intelegere-si-intrebari.md) | rezumat, presupuneri, întrebări deschise (cele blocante marcate) |
| [01 – Arhitectură](docs/faza-1/01-arhitectura-si-structura.md) | stivă, structura codului, licențe, regulile motorului de flux |
| [02 – Model de date](docs/faza-1/02-model-date.md) | entități, decizii, garanții (numerotare, audit, termene) |
| [03 – Contracte API](docs/faza-1/03-contracte-api.md) | API REST; contractul exact la `/api/docs` |
| [04 – Stare](docs/faza-1/04-stare-implementare.md) | criterii de acceptare, ce e făcut, ce lipsește |
| [processes/](processes) | pachetele P1, P2, P5 (definiții de proces și liste de verificare) |
| [JSON Schema](packages/process-schema/process-definition.schema.json) | formatul definițiilor de proces |
