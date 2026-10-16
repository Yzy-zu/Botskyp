#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
# Never inspect, dump or restore Evolution's database.
name="backups/botsky-$(date -u +%Y%m%dT%H%M%S)-$$.dump"
partial="$name.partial"
trap 'rm -f -- "$partial"' EXIT
compose exec -T postgres pg_dump -U botsky -d botsky -Fc > "$partial"
[[ -s "$partial" ]]
compose exec -T postgres pg_restore --list < "$partial" > /dev/null
mv -- "$partial" "$name"
sha256sum "$name" > "$name.sha256"
# Retain all backups until retention/deletion is separately authorized.
printf '%s\n' "$name"
