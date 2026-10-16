#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U botsky -d botsky -c \
  "INSERT INTO system_flags(key,value) VALUES('emergency','true') ON CONFLICT(key) DO UPDATE SET value='true',updated_at=now();"
compose stop app worker
printf 'Botsky detenido; bandera de emergencia persistida. Evolution sigue operando.\n'
