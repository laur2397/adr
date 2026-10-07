#!/usr/bin/env bash
# Daily backup: database (custom format) + document files, with SHA-256 sums.
# Run from deploy/ (cron: 30 1 * * * cd /opt/flux-am/deploy && ./backup.sh >> backup.log 2>&1).
# Copy the backups/ directory to offline media regularly (Legea 135/2007, NIS2): an online copy is not enough.
set -euo pipefail
cd "$(dirname "$0")"
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
docker compose exec -T db pg_dump -U flux -Fc flux > "backups/flux-db-$ts.dump"
docker compose run --rm --no-deps -T --entrypoint tar api czf - -C /data storage > "backups/flux-documents-$ts.tar.gz"
( cd backups && sha256sum "flux-db-$ts.dump" "flux-documents-$ts.tar.gz" > "flux-$ts.sha256" )
# Keep 30 days online.
find backups -name 'flux-*' -mtime +30 -delete
echo "backup $ts done: $(du -ch backups/*"$ts"* | tail -1 | cut -f1)"
