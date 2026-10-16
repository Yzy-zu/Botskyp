#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
umask 077
mkdir -p .local backups
chmod 700 .local backups
[[ -f .env && $(stat -c '%a' .env) == 600 ]] || { echo '.env debe existir con permisos 600' >&2; exit 1; }
compose() { docker compose --project-directory "$ROOT" -p botsky "$@"; }
