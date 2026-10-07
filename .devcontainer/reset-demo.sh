#!/usr/bin/env bash
# Rebuilds the demo database: about 70 dossiers of all types, worked by the demo users over the last
# 5 months (registers, signatures, debts, archive, e-mails, comments). Takes 3-6 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only || true
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @flux/web build >/dev/null
DB="${DATABASE_URL##*/}"
(cd apps/api && node -e "
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL); const db = url.pathname.slice(1); url.pathname = '/postgres';
const c = new Client(url.toString());
c.connect().then(async () => {
  await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = \$1 and pid <> pg_backend_pid()', [db]);
  await c.query('drop database if exists ' + db); await c.query('create database ' + db); await c.end();
});")
rm -rf "${STORAGE_DIR:-/home/node/flux-storage}"
SEED_DEMO=true ADMIN_PASSWORD=Demo-parola-2026 ORG_NAME="ADR Demo (date fictive)" pnpm --filter @flux/api seed
touch .devcontainer/.setup-done
echo "Gata. Reîncărcați pagina platformei (serverul repornește automat în câteva secunde)."
pkill -f "tsx src/main.ts" || true
