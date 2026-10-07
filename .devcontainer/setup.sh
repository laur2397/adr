#!/usr/bin/env bash
# Runs once when the codespace is created: dependencies, web build, database with demo data.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install -g pnpm@10.28.0 >/dev/null
pnpm install --frozen-lockfile
pnpm --filter @flux/web build
for i in $(seq 1 60); do
  (cd apps/api && node -e "new (require('pg').Client)(process.env.DATABASE_URL).connect().then(()=>process.exit(0),()=>process.exit(1))") && break
  echo "astept baza de date..."; sleep 2
done
SEED_DEMO=true ADMIN_PASSWORD=Demo-parola-2026 ORG_NAME="ADR Demo (date fictive)" pnpm --filter @flux/api seed
