#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
[[ $# == 1 && "$1" =~ ^backups/botsky-[a-zA-Z0-9_-]+\.dump$ ]] || { echo 'Indica un respaldo local de Botsky' >&2; exit 1; }
# Keep the selected archive pinned against concurrent retention during this test.
exec 8>.local/backup.lock
flock 8
python3 - "$1" <<'PY'
import sys
sys.path.insert(0, 'scripts')
from pathlib import Path
from backup import verify_checksum
if not verify_checksum(Path(sys.argv[1])):
    raise SystemExit('Checksum inválido; no se restaura')
PY
target="botsky-restore-test-$(date -u +%s)-$$"
created=false
cleanup() {
  if [[ "$created" == true ]]; then docker rm -f "$target" >/dev/null; fi
}
trap cleanup EXIT
# A new container, no network, tmpfs data. Production receives no restore commands.
image=$(docker inspect "$(compose ps -q postgres)" --format '{{.Image}}')
docker run --name "$target" --detach --network none --memory 256m --cpus 0.20 --pids-limit 64 \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=botsky -e POSTGRES_DB=botsky_restore_test "$image" >/dev/null
created=true
ready=false
for attempt in $(seq 1 30); do
  # The entrypoint's initialization server accepts Unix sockets before final startup.
  if docker exec "$target" psql -h 127.0.0.1 -U botsky -d botsky_restore_test -v ON_ERROR_STOP=1 -At -c 'SELECT 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
# Avoid exposing user data if PostgreSQL reports a COPY error.
if ! docker exec -i "$target" pg_restore -h 127.0.0.1 -U botsky -d botsky_restore_test --exit-on-error --single-transaction --no-owner < "$1" >.local/restore-test.log 2>&1; then
  echo 'Falló restore aislado; diagnóstico privado en .local/restore-test.log' >&2
  exit 1
fi
docker exec "$target" psql -h 127.0.0.1 -U botsky -d botsky_restore_test -v ON_ERROR_STOP=1 -c \
  'SELECT count(*) AS migrations FROM schema_migrations; SELECT count(*) AS outbox_rows FROM outbox; SELECT count(*) AS notes_rows FROM notes;'
printf 'Restauración aislada verificada; contenedor temporal eliminado al salir.\n'
