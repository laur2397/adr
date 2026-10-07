#!/usr/bin/env bash
# Runs at every start of the codespace: API (also serves the web interface) and worker.
cd "$(dirname "$0")/../apps/api"
export WEB_DIST="$PWD/../web/dist"
pkill -f "tsx src/main.ts" 2>/dev/null; pkill -f "tsx src/worker.ts" 2>/dev/null
setsid nohup node --import tsx src/main.ts > /tmp/flux-api.log 2>&1 < /dev/null &
setsid nohup node --import tsx src/worker.ts > /tmp/flux-worker.log 2>&1 < /dev/null &
for i in $(seq 1 30); do curl -sf http://localhost:3000/api/v1/ready >/dev/null && break; sleep 1; done
echo "Flux AM rulează pe portul 3000 (fila PORTS). Jurnale: /tmp/flux-api.log, /tmp/flux-worker.log"
