import { execFileSync } from 'node:child_process';
import { it } from 'vitest';
function python(code:string):void {
  execFileSync('python3',['-c',`import sys; sys.dont_write_bytecode=True; sys.path.insert(0,'scripts')\n${code}`],{stdio:'pipe'});
}
it('loads operator identities privately with environment precedence',()=>python(`
import tempfile,pathlib
from local_config import read_local_env,require_identities
with tempfile.TemporaryDirectory() as folder:
 p=pathlib.Path(folder)/'.env'
 p.write_text('OWNER_JIDS=100@s.whatsapp.net\\nBOT_JIDS=200@s.whatsapp.net\\nLAB_CHAT_ID=300@g.us\\n')
 values=require_identities(read_local_env(folder,{'OWNER_JIDS':'111@lid'}))
 assert values['OWNER_JIDS']=='111@lid'
 assert values['LAB_CHAT_ID']=='300@g.us'
`));
it('rejects missing identities without echoing their values',()=>python(`
from local_config import require_identities
try:
 require_identities({'OWNER_JIDS':'sensitive-invalid-value'})
except ValueError as error:
 assert 'sensitive-invalid-value' not in str(error)
else:
 raise AssertionError('Invalid configuration accepted')
`));
it('anonymizes fixtures from a private mapping and rejects unmapped identities',()=>python(`
import importlib.util,json,tempfile,pathlib
from local_config import read_identity_map
spec=importlib.util.spec_from_file_location('exporter','scripts/export-fixtures.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
original='9'*12+'@s.whatsapp.net'
with tempfile.TemporaryDirectory() as folder:
 p=pathlib.Path(folder)/'identities.json';p.write_text(json.dumps({original:'100@s.whatsapp.net'}))
 module.identities.update(read_identity_map(p))
 assert module.replace_text(original)=='100@s.whatsapp.net'
 assert module.replace_text('@'+'9'*12)=='@100'
 try:
  module.replace_text('8'*12+'@lid')
 except ValueError:
  pass
 else:
  raise AssertionError('Unmapped identity leaked')
`));
