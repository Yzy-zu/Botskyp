#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
[[ $# == 1 && "$1" =~ ^backups/botsky-[a-zA-Z0-9_-]+\.dump$ ]] || { echo 'Indica un respaldo local de Botsky' >&2; exit 1; }
[[ -f "$1.sha256" ]]
sha256sum --check --status "$1.sha256"
# A fresh database is mandatory. This command cannot overwrite a live database.
target="botsky_restore_$(date -u +%s)_$$"
compose exec -T postgres createdb -U botsky "$target"
compose exec -T postgres pg_restore -U botsky -d "$target" --exit-on-error --no-owner < "$1"
compose exec -T postgres psql -U botsky -d "$target" -v ON_ERROR_STOP=1 -c \
  'SELECT count(*) AS migrations FROM schema_migrations; SELECT count(*) AS outbox_rows FROM outbox;'
printf 'Restauración aislada verificada: %s (se conserva para inspección)\n' "$target"
