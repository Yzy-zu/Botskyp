#!/usr/bin/env python3
"""Export structurally faithful, minimal fixtures from actual captured webhooks."""
import argparse, hashlib, json, pathlib, re
from local_config import read_identity_map, read_local_env
ROOT=pathlib.Path(__file__).resolve().parent.parent
identities = {}

def replace_text(value):
    for original,anonymous in identities.items():
        value=value.replace(original,anonymous)
        value=value.replace('@'+original.split('@')[0],'@'+anonymous.split('@')[0])
    for original, anonymous in identities.items():
        value = re.sub(r'(?<!\d)' + re.escape(original.split('@')[0]) + r'(?!\d)', anonymous.split('@')[0], value)
    if re.search(r'\d{7,}@(g\.us|s\.whatsapp\.net|lid)|@\d{7,}', value):
        raise ValueError('Unmapped fixture identity; update the private mapping')
    return value

def safe_key(value):
    return {k:replace_text(v) if isinstance(v,str) else v for k,v in value.items()
        if k in ['id','remoteJid','remoteJidAlt','participant','participantAlt','fromMe','addressingMode']}

def safe_context(value):
    result={k:v for k,v in value.items() if k in ['stanzaId','participant','remoteJid','mentionedJid']}
    if 'quotedMessage' in value:result['quotedMessage']=safe_message(value['quotedMessage'])
    return result

def safe_message(value):
    result={}
    for kind,payload in value.items():
        if kind=='conversation':result[kind]=payload
        elif kind in ['extendedTextMessage','audioMessage','imageMessage','documentMessage','videoMessage','stickerMessage','reactionMessage']:
            kept={k:v for k,v in payload.items() if k in ['text','caption','mimetype','fileName','seconds','ptt','senderTimestampMs']}
            if 'contextInfo' in payload:kept['contextInfo']=safe_context(payload['contextInfo'])
            if 'key' in payload:kept['key']=safe_key(payload['key'])
            result[kind]=kept
    return result

def anonymize(value,key=''):
    if isinstance(value,dict):return {k:anonymize(v,k) for k,v in value.items()}
    if isinstance(value,list):return [anonymize(v,key) for v in value]
    if isinstance(value,str):
        if key in ['id','stanzaId'] and '@' not in value:return 'msg-'+hashlib.sha256(value.encode()).hexdigest()[:12]
        if key=='fileName':return 'ejemplo.pdf'
        return replace_text(value)
    return value

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--identities', type=pathlib.Path,
        default=pathlib.Path(read_local_env().get('FIXTURE_IDENTITIES_FILE', ROOT / '.local/fixture-identities.json')))
    args = parser.parse_args()
    identities.update(read_identity_map(args.identities))
    manifest=[]
    for source in sorted((ROOT/'.local/captures').glob('*.json')):
        event=json.loads(source.read_text());data=event.get('data',{})
        if event.get('event')!='messages.upsert':continue
        fixture={k:event[k] for k in ['event','instance','date_time'] if k in event}
        fixture['data']={k:data[k] for k in ['messageType','messageTimestamp','source','status'] if k in data}
        fixture['data']['key']=safe_key(data['key'])
        fixture['data']['message']=safe_message(data.get('message',{}))
        if 'contextInfo' in data:fixture['data']['contextInfo']=safe_context(data['contextInfo'])
        kind=data.get('messageType','unknown')
        if kind=='conversation':
            context=data.get('contextInfo',{})
            kind='text-private' if not data['key']['remoteJid'].endswith('@g.us') else 'quote' if context.get('stanzaId') else 'mention' if context.get('mentionedJid') else 'text-group'
        name=kind+'.json'
        (ROOT/'tests/fixtures'/name).write_text(json.dumps(anonymize(fixture),ensure_ascii=False,indent=2)+'\n')
        manifest.append({'fixture':name,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'origin':'captured-webhook'})
    (ROOT/'tests/fixtures/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Exported actual webhook fixtures:',', '.join(x['fixture'] for x in manifest))
    # Earlier text webhooks exhausted retries. Their original REST records are retained
    # as REST fixtures, without manufacturing webhook envelopes around them.
    history=ROOT/'.local/recent-messages.json'
    if history.exists():
        original=json.loads(history.read_text())
        records=[]
        for row in original['messages']['records']:
            safe={k:row[k] for k in ['messageType','messageTimestamp','source'] if k in row}
            safe['key']=safe_key(row['key'])
            safe['message']=safe_message(row.get('message',{}))
            if isinstance(row.get('contextInfo'),dict):safe['contextInfo']=safe_context(row['contextInfo'])
            records.append(safe)
        result={'messages':{k:v for k,v in original['messages'].items() if k in ['total','pages','currentPage']}}
        result['messages']['records']=records
        (ROOT/'tests/fixtures/history.json').write_text(json.dumps(anonymize(result),ensure_ascii=False,indent=2)+'\n')
        manifest.append({'fixture':'history.json','sourceSha256':hashlib.sha256(history.read_bytes()).hexdigest(),'origin':'captured-rest-response'})
        (ROOT/'tests/fixtures/manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
        print('Exported real REST history separately; no generated webhook envelopes')

if __name__ == '__main__':
    main()
