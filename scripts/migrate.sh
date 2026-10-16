#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
[[ -f .local/current-compose.json ]] || { echo 'Primero despliega mediante scripts/deploy.sh' >&2; exit 1; }
compose -f .local/current-compose.json run --rm --no-deps app node dist/src/db/migrate.js
