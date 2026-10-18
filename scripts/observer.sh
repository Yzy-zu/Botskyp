#!/usr/bin/env bash
set -Eeuo pipefail
cd -- "$(dirname -- "$0")/.."
umask 077
# Separate container/cgroup: a large forensic export cannot exhaust the running app.
# The resolved deployment pins the actual running image, volume and environment.
exec docker compose -p botsky -f .local/current-compose.json run --rm --no-deps -T app node dist/src/observer/cli.js "$@"
