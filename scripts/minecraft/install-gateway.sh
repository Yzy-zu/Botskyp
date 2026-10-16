#!/usr/bin/env bash
# Run as root on redspi after reviewing the gateway. Argument is a PUBLIC key file.
set -Eeuo pipefail
[[ $(hostname) == redspi && $# == 1 ]] || { echo 'Solo redspi; requiere archivo de llave pública' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
[[ $(wc -l < "$1") == 1 ]] && ssh-keygen -l -f "$1" >/dev/null
if ! id botsky-mc >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/botsky-mc --shell /bin/sh botsky-mc
fi
[[ $(id -nG botsky-mc) != *docker* ]] || { echo 'La cuenta no debe pertenecer a docker' >&2; exit 1; }
install -d -o root -g root -m 755 /opt/botsky /var/lib/botsky-mc /var/lib/botsky-mc/.ssh
install -d -o root -g root -m 700 /var/lib/botsky-minecraft /var/lib/botsky-minecraft/receipts /var/lib/botsky-minecraft/backups
install -o root -g root -m 755 "$source_dir/mc-ctl.sh" /opt/botsky/mc-ctl.sh
install -o root -g root -m 755 "$source_dir/mc-control.py" /opt/botsky/mc-control.py
# This dedicated account is managed exclusively by this phase. Refuse unrelated keys.
key_line="from=\"100.109.237.37\",restrict,command=\"/opt/botsky/mc-ctl.sh\" $(cat -- "$1")"
auth=/var/lib/botsky-mc/.ssh/authorized_keys
if [[ -s "$auth" ]] && [[ $(cat "$auth") != "$key_line" ]]; then
  echo 'authorized_keys existente distinto: no se sobrescribe' >&2; exit 1
fi
printf '%s\n' "$key_line" > "$auth"
chown root:root "$auth"
chmod 644 "$auth"
tmp_sudo=$(mktemp)
trap 'rm -f -- "$tmp_sudo"' EXIT
printf '%s\n' 'botsky-mc ALL=(root) NOPASSWD: /opt/botsky/mc-control.py *' > "$tmp_sudo"
visudo -cf "$tmp_sudo" >/dev/null
install -o root -g root -m 440 "$tmp_sudo" /etc/sudoers.d/botsky-minecraft
# Existing user allowlist is retained; only the new account/source is added.
install -o root -g root -m 644 "$source_dir/sshd-botsky.conf" /etc/ssh/sshd_config.d/60-botsky-minecraft.conf
/usr/sbin/sshd -t
systemctl reload ssh
echo 'Gateway instalado; no se modificó el contenedor Minecraft ni sus datos.'
