#!/usr/bin/env bash
source "$(dirname -- "$0")/common.sh"
# Serialize dump + verification + rotation across cron and deploy.
exec 8>.local/backup.lock
flock 8
python3 scripts/backup.py
