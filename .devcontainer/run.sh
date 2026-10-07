#!/usr/bin/env bash
# Main process of the codespace container: waits for setup.sh, then keeps the API (which also
# serves the web interface) and the worker running, restarting them if they stop.
cd "$(dirname "$0")/.."
until [ -f .devcontainer/.setup-done ] && [ -f apps/web/dist/index.html ]; do sleep 3; done
cd apps/api
export WEB_DIST="$PWD/../web/dist"
( while true; do node --import tsx src/worker.ts >> /tmp/flux-worker.log 2>&1; sleep 3; done ) &
while true; do node --import tsx src/main.ts >> /tmp/flux-api.log 2>&1; echo "api stopped, restarting" >> /tmp/flux-api.log; sleep 3; done
