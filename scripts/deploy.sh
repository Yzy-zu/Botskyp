#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
# Parse the full deployment before git pull can replace this file.
deploy() {
exec 9>.local/deploy.lock
flock -n 9 || { echo 'Ya hay un despliegue activo' >&2; exit 1; }
mode=${1:-deploy}
[[ "$mode" == deploy || "$mode" == --test-rollback || "$mode" == --database-only || "$mode" == --capture ]] || { echo 'Uso: scripts/deploy.sh [--test-rollback|--database-only|--capture]' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'Haz commit de cambios antes de desplegar' >&2; exit 1; }
compose config -q
# Back up existing data before applying any changed database container settings.
existing=$(compose ps --all --quiet postgres)
if [[ -n "$existing" ]]; then
  if [[ $(docker inspect "$existing" --format '{{.State.Running}}') != true ]]; then
    docker start "$existing" >/dev/null
  fi
  backup=$(scripts/backup.sh)
  compose up -d --wait postgres
else
  # First bootstrap: initialize the empty dedicated database, then back it up.
  compose up -d --wait postgres
  backup=$(scripts/backup.sh)
fi
printf 'Respaldo verificado: %s\n' "$backup"
[[ "$mode" != --database-only ]] || exit 0
if [[ "$mode" == --capture ]]; then
  compose --profile capture up -d --no-deps --wait capture
  exit 0
fi
previous=.local/current-compose.json
candidate=.local/candidate-compose.json
rollback_needed=false
rollback() {
  local code=$?
  trap - ERR INT TERM
  if [[ "$rollback_needed" == true ]]; then
    echo 'Fallo de despliegue: iniciando rollback de app y worker' >&2
    if [[ -f "$previous" ]]; then
      compose -f "$previous" up -d --no-build --wait --wait-timeout 60 app worker || { echo 'FALLÓ rollback; requiere intervención' >&2; exit 2; }
      echo 'Rollback verificado: servicios anteriores healthy' >&2
    else
      compose stop app worker
      echo 'Primer despliegue fallido: app/worker detenidos; BD y respaldo conservados' >&2
    fi
  fi
  exit "$code"
}
trap rollback ERR
trap 'false' INT TERM
if git rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
  git pull --ff-only
fi
[[ -z $(git status --porcelain --untracked-files=no) ]]
image="botsky:$(git rev-parse --short=12 HEAD)"
BOTSKY_IMAGE="$image" compose build app
# Pin rollback to the immutable image ID, even when rebuilding the same commit.
if [[ "$mode" == --test-rollback ]]; then
  [[ -f "$previous" ]] || { echo 'Primero se necesita un despliegue sano' >&2; false; }
  docker build --tag "$image-rollback-probe" --file - . <<EOF_PROBE
FROM $image
ENV BOTSKY_ROLLBACK_PROBE=1
EOF_PROBE
  image="$image-rollback-probe"
fi
image_id=$(docker image inspect "$image" --format '{{.Id}}')
BOTSKY_IMAGE="$image_id" compose config --format json > "$candidate"
if [[ "$mode" == --test-rollback ]]; then
  python3 - "$candidate" <<'PY_PROBE'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1]); data=json.loads(p.read_text())
data['services']['app']['command']=['node','-e','process.exit(42)']
p.write_text(json.dumps(data))
PY_PROBE
fi
rollback_needed=true
compose -f "$candidate" run --rm --no-deps app node dist/src/db/migrate.js
compose -f "$candidate" up -d --wait --wait-timeout 60 searxng
compose -f "$candidate" up -d --no-build --wait --wait-timeout 60 app worker
if [[ "$mode" == --test-rollback ]]; then
  [[ -f "$previous" ]] || { echo 'Primero se necesita un despliegue sano' >&2; false; }
  echo 'El candidato de prueba llegó inesperadamente a aceptación' >&2
  false
fi
python3 scripts/install-backup-cron.py
mv -- "$candidate" "$previous"
printf '%s\n' "$image_id" > .local/deployed-image
printf 'Despliegue sano: %s\n' "$(git rev-parse --short HEAD)"
}
deploy "$@"
