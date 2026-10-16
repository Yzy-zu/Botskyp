#!/usr/bin/env python3
"""Local operations; never print credentials or provider response bodies."""
import json, os, pathlib, re, secrets, subprocess, sys, urllib.request
from local_config import read_local_env, require_identities
ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local'
LOCAL.mkdir(mode=0o700, exist_ok=True)
os.umask(0o077)

def private(name, data):
    (LOCAL / name).write_text(json.dumps(data, indent=2))

def api(path, data=None):
    c = json.loads(subprocess.check_output(['docker', 'inspect', 'evolution_api']))[0]
    env = dict(x.split('=', 1) for x in c['Config']['Env'])
    req = urllib.request.Request('http://127.0.0.1:8080/' + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers={'apikey': env['AUTHENTICATION_API_KEY'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k,v in value.items() if not any(s in k.lower() for s in
            ['apikey','secret','token','password','authorization','mediakey','base64','thumbnail','sha256','url','directpath'])}
    if isinstance(value, list):
        return [clean(x) for x in value]
    return value

if __name__ == '__main__':
    action = sys.argv[1]
    values = read_local_env()
    instance = values.get('INSTANCE', 'botsky')
    if not re.fullmatch(r'[\w-]+', instance):
        raise SystemExit('Invalid INSTANCE')
    if action == 'prepare':
        require_identities(values)
        lab = values['LAB_CHAT_ID']
        previous = api('webhook/find/' + instance)
        if not (LOCAL / 'webhook-before.json').exists():
            private('webhook-before.json', previous)
        if previous and previous.get('enabled'):
            raise SystemExit('Existing enabled webhook requires inspection before replacement')
        c = json.loads(subprocess.check_output(['docker','inspect','evolution_api']))[0]
        env = dict(x.split('=',1) for x in c['Config']['Env'])
        if 'WEBHOOKS' in env.get('LOG_LEVEL','').split(','):
            raise SystemExit('Provider webhook logging enabled; inspect before capture')
        has_config = (ROOT / '.env').exists() and any(line.startswith('WEBHOOK_SECRET=') for line in (ROOT / '.env').read_text().splitlines())
        if not has_config:
            password = secrets.token_hex(24)
            values = {'POSTGRES_PASSWORD':password,'DATABASE_URL':f'postgresql://botsky:{password}@botsky-db:5432/botsky',
              'EVOLUTION_URL':'http://evolution_api:8080','EVOLUTION_APIKEY':env['AUTHENTICATION_API_KEY'],
              'INSTANCE':instance,'WEBHOOK_SECRET':secrets.token_hex(32),'OWNER_JIDS':values['OWNER_JIDS'],
              'BOT_JIDS':values['BOT_JIDS'],
              'LAB_CHAT_ID':lab,'TZ_DEFAULT':'America/Mexico_City','STALE_SECONDS':'120',
              'TRANSPORT':'evolution','CAPTURE_ENABLED':'true','BIND_PORT':'3000'}
            existing = (ROOT / '.env').read_text() if (ROOT / '.env').exists() else ''
            if not (LOCAL / 'legacy-env-backup.json').exists():
                private('legacy-env-backup.json', {'original': existing})
            (ROOT / '.env').write_text('# Botsky phase 0\n' + ''.join(f'{k}={v}\n' for k,v in values.items()))
        private('participants.json', clean(api('group/findGroupInfos/' + instance + '?groupJid=' + lab)))
        print('Private configuration prepared; no Evolution changes yet')
    elif action in ['capture','app','restore']:
        if action == 'restore':
            old=json.loads((LOCAL/'webhook-before.json').read_text())
            wh = {'enabled':False,'url':'','events':[],'byEvents':False,'base64':False,'headers':{}} if old is None else {
              'enabled':old['enabled'],'url':old['url'],'events':old['events'],'byEvents':old.get('webhookByEvents',False),
              'base64':old.get('webhookBase64',False),'headers':old.get('headers') or {}}
        else:
            wh={'enabled':True,'url':'http://botsky-capture:3001/webhook' if action=='capture' else 'http://botsky-app:3000/webhook',
                'headers':{'x-webhook-secret':values['WEBHOOK_SECRET']},'byEvents':False,'base64':False,
                'events':['MESSAGES_UPSERT','SEND_MESSAGE','CONNECTION_UPDATE','GROUP_PARTICIPANTS_UPDATE']}
        api('webhook/set/' + instance,{'webhook':wh})
        check=api('webhook/find/' + instance)
        assert check['enabled']==wh['enabled'] and check['url']==wh['url']
        print('Webhook configuration applied and verified:', action)
    elif action == 'state':
        print('Connection state:', api('instance/connectionState/' + instance)['instance']['state'])
