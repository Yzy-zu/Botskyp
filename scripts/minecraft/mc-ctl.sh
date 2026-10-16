#!/bin/sh
# Root-owned forced command. No eval, shell parsing, forwarding, or interactive IO.
exec /usr/bin/sudo -n /opt/botsky/mc-control.py "${SSH_ORIGINAL_COMMAND-}"
