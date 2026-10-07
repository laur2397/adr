# Flux AM

Sistem de management electronic al documentelor si fluxurilor pentru Agentiile pentru Dezvoltare
Regionala (ADR) si alte Autoritati de Management / Organisme Intermediare pentru fonduri europene:
registratura, circuite interne de verificare si avizare (CR/CP, achizitii), semnare electronica
calificata, termene legale si audit.

**Stare:** Faza 1 – design, inainte de cod. Conform regulii de lucru din specificatie, codul
porneste dupa confirmarea intelegerii si raspunsul la intrebarile deschise.

## Documente

| Document | Continut |
|---|---|
| [docs/faza-1/00-intelegere-si-intrebari.md](docs/faza-1/00-intelegere-si-intrebari.md) | ce am inteles, presupuneri, intrebari deschise (cele blocante marcate) |
| [docs/faza-1/01-arhitectura-si-structura.md](docs/faza-1/01-arhitectura-si-structura.md) | stiva, structura monorepo, licente, reguli ale motorului de flux |
| [docs/faza-1/02-model-date.md](docs/faza-1/02-model-date.md) | modelul de date si deciziile din spatele lui |
| [docs/faza-1/03-contracte-api.md](docs/faza-1/03-contracte-api.md) | API REST propus pentru Faza 1 |
| [db/migrations/0001_schema.sql](db/migrations/0001_schema.sql) | schema PostgreSQL 16 (devine prima migrare) |
| [packages/process-schema/process-definition.schema.json](packages/process-schema/process-definition.schema.json) | JSON Schema pentru definitiile de proces |
| [examples/process-p1.json](examples/process-p1.json) | pachetul P1 (verificarea cererii de rambursare/plata) descris in acest format |

## Verificarea schemei

```bash
PGHOST=localhost PGUSER=postgres db/tests/verify-schema.sh
```

Verifica pe o baza temporara: numerotare fara goluri la 100 de inregistrari simultane, jurnal de
audit append-only cu lant de hash-uri (inclusiv detectarea alterarii) si imuabilitatea
definitiilor publicate.
