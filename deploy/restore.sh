#!/usr/bin/env bash
# Restores a backup made by backup.sh: ./restore.sh 20261007-013000
# Stops the application, replaces the database and the document files, starts it again.
set -euo pipefail
cd "$(dirname "$0")"
ts="${1:?usage: ./restore.sh <timestamp from the backup file names>}"
( cd backups && sha256sum -c "flux-$ts.sha256" )
read -r -p "The current data will be REPLACED with backup $ts. Type YES to continue: " answer
[ "$answer" = "YES" ] || exit 1
docker compose stop api worker
docker compose exec -T db psql -U flux -d postgres -c "drop database if exists flux with (force)" -c "create database flux owner flux"
docker compose exec -T db pg_restore -U flux -d flux --no-owner < "backups/flux-db-$ts.dump"
docker compose run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /data/storage/* && tar xzf - -C /data' < "backups/flux-documents-$ts.tar.gz"
docker compose start api worker
echo "restored $ts; check Administrare > Audit > Verifică lanțul"
