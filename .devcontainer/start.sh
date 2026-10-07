#!/usr/bin/env bash
# Checks that Flux AM answers on port 3000; runs the setup again if it never completed.
cd "$(dirname "$0")/.."
[ -f .devcontainer/.setup-done ] || bash .devcontainer/setup.sh
for i in $(seq 1 60); do
  if curl -sf http://localhost:3000/api/v1/ready >/dev/null; then
    echo "Flux AM rulează pe portul 3000 (fila PORTS)."
    exit 0
  fi
  sleep 2
done
echo "Flux AM nu răspunde încă. Ultimele rânduri din jurnal:"
tail -30 /tmp/flux-api.log 2>/dev/null
