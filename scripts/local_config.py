"""Read private runtime configuration without shell evaluation or value logging."""
import json
import os
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
JID = re.compile(r'^\d+@(g\.us|s\.whatsapp\.net|lid)$')


def read_local_env(root=ROOT, environ=None):
    values = {}
    path = pathlib.Path(root) / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key] = value
    values.update(os.environ if environ is None else environ)
    return values


def require_identities(values):
    for key in ['OWNER_JIDS', 'BOT_JIDS']:
        ids = [value.strip() for value in values.get(key, '').split(',')]
        if not ids or any(not re.fullmatch(r'\d+@(s\.whatsapp\.net|lid)', value) for value in ids):
            raise ValueError('Missing or invalid ' + key)
    if not re.fullmatch(r'\d+@g\.us', values.get('LAB_CHAT_ID', '')):
        raise ValueError('Missing or invalid LAB_CHAT_ID')
    if not re.fullmatch(r'[\w-]+', values.get('INSTANCE', 'botsky')):
        raise ValueError('Invalid INSTANCE')
    return values


def read_identity_map(path):
    identities = json.loads(pathlib.Path(path).read_text())
    if not isinstance(identities, dict) or not identities:
        raise ValueError('Private fixture identity map is required')
    for original, anonymous in identities.items():
        if not isinstance(original, str) or not JID.fullmatch(original):
            raise ValueError('Invalid identity map source')
        if not isinstance(anonymous, str) or not re.fullmatch(r'\d{1,6}@(g\.us|s\.whatsapp\.net|lid)', anonymous):
            raise ValueError('Identity map targets must be synthetic short JIDs')
    return identities
