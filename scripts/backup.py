#!/usr/bin/env python3
"""Verified local PostgreSQL archives with deterministic retention and optional copy."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r'botsky-[a-zA-Z0-9_-]+\.dump')
RETAIN = 7


def regular(path):
    return path.exists() and stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink()


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify_checksum(path):
    checksum = path.with_name(path.name + '.sha256')
    if not NAME.fullmatch(path.name) or not regular(path) or not regular(checksum):
        return False
    fields = checksum.read_text().strip().split()
    return (len(fields) == 2 and fields[1] in (path.name, 'backups/' + path.name)
            and re.fullmatch(r'[0-9a-f]{64}', fields[0]) is not None and digest(path) == fields[0])


def rotate(directory, validate):
    # Only a checksum plus complete archive validation makes a retention candidate.
    valid = []
    for path in sorted(directory.iterdir()):
        if verify_checksum(path) and validate(path):
            valid.append(path)
    valid.sort(key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    for path in valid[RETAIN:]:
        path.unlink()
        path.with_name(path.name + '.sha256').unlink()
    return len(valid[:RETAIN])


def compose(*args):
    return ['docker', 'compose', '--project-directory', str(ROOT), '-p', 'botsky', *args]


def archive_valid(path):
    with path.open('rb') as source:
        result = subprocess.run(compose('exec', '-T', 'postgres', 'pg_restore', '--file=/dev/null'),
                                stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
    return result.returncode == 0


def optional_copy(path):
    # Separate configuration from library readonly rclone/OAuth. Never bootstrap OAuth.
    folder = ROOT / '.local' / 'backup'
    config, remote = folder / 'rclone.conf', folder / 'remote.json'
    if not config.exists() or not remote.exists() or shutil.which('rclone') is None:
        return
    if any(not regular(p) or stat.S_IMODE(p.stat().st_mode) != 0o600 for p in (config, remote)):
        raise ValueError('Invalid private backup configuration permissions')
    destination = json.loads(remote.read_text())
    if not isinstance(destination, dict) or set(destination) != {'destination'}:
        raise ValueError('Invalid backup destination configuration')
    target = destination['destination']
    if not isinstance(target, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]*:[A-Za-z0-9_/-]+', target) or '..' in target.split('/'):
        raise ValueError('Invalid backup destination')
    name = target.split(':', 1)[0]
    remotes = subprocess.run(['rclone', '--config', str(config), 'listremotes'], capture_output=True, text=True, timeout=15, check=True)
    if name + ':' not in remotes.stdout.splitlines():
        raise ValueError('Backup remote is not configured')
    for source in (path, path.with_name(path.name + '.sha256')):
        subprocess.run(['rclone', '--config', str(config), 'copyto', '--timeout', '30s', '--retries', '1', str(source), target.rstrip('/') + '/' + source.name],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=180)


def backup():
    directory = ROOT / 'backups'
    path = directory / ('botsky-' + time.strftime('%Y%m%dT%H%M%S', time.gmtime()) + '-' + str(os.getpid()) + '.dump')
    partial = path.with_name(path.name + '.partial')
    try:
        with partial.open('xb') as output:
            subprocess.run(compose('exec', '-T', 'postgres', 'pg_dump', '-U', 'botsky', '-d', 'botsky', '-Fc'),
                           stdout=output, stderr=subprocess.DEVNULL, check=True, timeout=180)
            output.flush()
            os.fsync(output.fileno())
        if partial.stat().st_size == 0 or not archive_valid(partial):
            raise ValueError('Archive verification failed')
        partial.rename(path)
        with path.with_name(path.name + '.sha256').open('x') as checksum:
            checksum.write(digest(path) + '  ' + path.name + '\n')
            checksum.flush()
            os.fsync(checksum.fileno())
        if not verify_checksum(path):
            raise ValueError('Checksum verification failed')
        rotate(directory, archive_valid)
        try:
            optional_copy(path)
        except (OSError, ValueError, subprocess.SubprocessError):
            print('Backup local verificado; copia externa no disponible.', file=sys.stderr)
        print('backups/' + path.name)
    finally:
        partial.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        backup()
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Falló el backup; no se rotaron copias sin verificación previa.', file=sys.stderr)
        sys.exit(1)
