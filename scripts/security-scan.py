#!/usr/bin/env python3
"""Scan versioned content without ever printing the matching secret or identity."""
from pathlib import Path
import re
import subprocess
import sys
from local_config import read_local_env

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----'),
    'google-key': re.compile(r'AIza[0-9A-Za-z_-]{35}'),
    'api-token': re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{16})'),
    'jwt': re.compile(r'eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}'),
    'personal-jid': re.compile(r'(?<![0-9])\d{8,}(?:[-:]\d+)?@(?:s\.whatsapp\.net|g\.us|lid)'),
    'phone': re.compile(r'(?i)(?:tel[eé]fono|phone|whatsapp|OWNER_JIDS|BOT_JIDS)\s*[:=]\s*[\x22\x27]?\+?\d[\d ()-]{8,}\d'),
    'literal-secret': re.compile(r'(?i)(?:password|passwd|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[\x22\x27]?\s*[:=]\s*[\x22\x27]([A-Za-z0-9_+/=-]{24,})[\x22\x27]'),
    'host-credential': re.compile(r'(?i)(?:postgres(?:ql)?|https?|ssh)://[^\s/:\x22\x27]+:([^\s@/\x22\x27]{12,})@(?!localhost|127\.0\.0\.1|botsky-db|example\.)[^\s/]+'),
}


def findings(content, secrets=()):
    result = set()
    for name, pattern in PATTERNS.items():
        for match in pattern.finditer(content):
            # Long repeated placeholders in tests/examples are not credentials.
            if name == 'literal-secret' and len(set(match.group(1))) < 4:
                continue
            result.add(name)
    if any(value in content for value in secrets):
        result.add('local-private-value')
    return sorted(result)


def history_findings(secrets):
    objects = subprocess.check_output(['git', 'rev-list', '--objects', '--all'], cwd=ROOT).splitlines()
    ids = [line.split(b' ', 1)[0] for line in objects]
    checked = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
                             input=b'\n'.join(ids) + b'\n', capture_output=True, check=True, cwd=ROOT).stdout.splitlines()
    blobs = [line.split()[0] for line in checked if line.split()[1] == b'blob' and int(line.split()[2]) <= 2_000_000]
    data = subprocess.run(['git', 'cat-file', '--batch'], input=b'\n'.join(blobs) + b'\n',
                          capture_output=True, check=True, cwd=ROOT).stdout
    offset, count = 0, 0
    categories = {}
    while offset < len(data):
        end = data.index(b'\n', offset)
        size = int(data[offset:end].split()[2])
        content = data[end + 1:end + 1 + size].decode('utf-8', errors='replace')
        offset = end + 1 + size + 1
        found = findings(content, secrets)
        if found:
            count += 1
            for kind in found:
                categories[kind] = categories.get(kind, 0) + 1
    # Only counts/categories; no secret, JID, line excerpt or blob data in reports.
    print(f'Historial: {len(blobs)} blobs examinados; {count} con hallazgos; categorías {categories}. Valores omitidos.')
    return count


def main():
    values = read_local_env(ROOT, {})
    secrets = []
    for key, value in values.items():
        if re.search(r'KEY|TOKEN|SECRET|PASSWORD|JIDS|CHAT_ID', key):
            secrets.extend(v.strip() for v in value.split(',') if len(v.strip()) >= 12)
            if re.search(r'JIDS|CHAT_ID', key):
                secrets.extend(v.split('@')[0] for v in value.split(',') if re.fullmatch(r'\d{8,}@(s\.whatsapp\.net|g\.us|lid)', v))
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    count = 0
    for name in paths:
        if not name:
            continue
        path = ROOT / name
        if path.is_symlink():
            print(f'{name}: enlace versionado no permitido')
            count += 1
            continue
        if not path.is_file():
            continue
        found = findings(path.read_bytes().decode('utf-8', errors='replace'), secrets)
        if found:
            print(f'{name}: {", ".join(found)} [valor omitido]')
            count += 1
    print(f'Auditoría de archivos versionados: {count} archivo(s) con hallazgos.')
    if '--history' in sys.argv[1:]:
        count += history_findings(secrets)
    return 1 if count else 0


if __name__ == '__main__':
    sys.exit(main())
