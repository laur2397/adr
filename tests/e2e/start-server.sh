#!/usr/bin/env bash
# Starts a fresh Flux AM (API + worker + built web app) on a dedicated database for the UI tests.
set -euo pipefail
cd "$(dirname "$0")/../.."
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://postgres@127.0.0.1:5432/flux_e2e}"
export STORAGE_DIR="${E2E_STORAGE_DIR:-/tmp/flux-e2e-storage}"
export ANAF_MODE=mock SIGNATURE_PROVIDER=simulated APP_KEY="${APP_KEY:-$(head -c 32 /dev/urandom | base64)}"
export PORT="${E2E_PORT:-3100}" WEB_DIST="$PWD/apps/web/dist" OUTBOX_INTERVAL_MS=500
db="${DATABASE_URL##*/}"
admin_url="${DATABASE_URL%/*}/postgres"
psql "$admin_url" -qc "drop database if exists $db" -c "create database $db"
rm -rf "$STORAGE_DIR"
[ -f apps/web/dist/index.html ] || pnpm --filter @flux/web build
SEED_DEMO=true SEED_SIMULATE=false ADMIN_PASSWORD=Parola-e2e-2026 pnpm --filter @flux/api seed >/dev/null
pnpm --filter @flux/api start:worker &
exec pnpm --filter @flux/api start
