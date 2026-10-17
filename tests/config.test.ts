import { expect,it } from 'vitest';
import { readConfig } from '../src/config.js';
const valid={GEMINI_API_KEY:'fixture-gemini-key',DATABASE_URL:'postgresql://botsky:private-password@botsky-db:5432/botsky',EVOLUTION_URL:'http://evolution_api:8080',EVOLUTION_APIKEY:'private-api-key',INSTANCE:'botsky',WEBHOOK_SECRET:'s'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'evolution'};
it('requires the dedicated database when using Evolution',()=>{
  expect(readConfig(valid).TRANSPORT).toBe('evolution');
  expect(()=>readConfig({...valid,DATABASE_URL:valid.DATABASE_URL.replace('@botsky-db:','@postgres:')})).toThrow('dedicated');
});
it('never embeds secret values in validation errors',()=>{
  try{readConfig({...valid,WEBHOOK_SECRET:'private-secret',DATABASE_URL:'private-url'});throw new Error('Expected validation failure');}
  catch(err){expect(String(err)).not.toContain('private-secret');expect(String(err)).not.toContain('private-url');expect(String(err)).toContain('WEBHOOK_SECRET');}
});
it('defaults to v1 and validates the three inert router modes',()=>{
  expect(readConfig(valid).ROUTER_MODE).toBe('v1');
  for(const mode of ['v1','v1_1_shadow','v1_1'])expect(readConfig({...valid,ROUTER_MODE:mode}).ROUTER_MODE).toBe(mode);
  expect(()=>readConfig({...valid,ROUTER_MODE:'v2'})).toThrow('ROUTER_MODE');
});
it('defaults to unlimited local protection and supports explicit bounded increases and reductions',()=>{
  expect(readConfig(valid)).toMatchObject({GEMINI_USER_RPM:0,GEMINI_GLOBAL_RPM:0,GEMINI_DAILY_LIMIT:0,GEMINI_INPUT_TPM:0,LLM_USER_RPM:0,LLM_GLOBAL_RPM:0,LLM_DAILY_LIMIT:0,LLM_LOCAL_USER_RPM:0,LLM_LOCAL_GLOBAL_RPM:0,LLM_LOCAL_DAILY_LIMIT:0,LLM_MAX_CONCURRENT_CALLS:4,LLM_INPUT_TOKENS_PER_MINUTE:0,LLM_RESERVED_INPUT_TOKENS:32768});
  const limits={LLM_LOCAL_USER_RPM:10000,LLM_LOCAL_GLOBAL_RPM:10000,LLM_LOCAL_DAILY_LIMIT:1000000,LLM_USER_RPM:10000,LLM_GLOBAL_RPM:10000,LLM_DAILY_LIMIT:1000000,LLM_INPUT_TOKENS_PER_MINUTE:10000000,LLM_RESERVED_INPUT_TOKENS:10000000,GEMINI_USER_RPM:10000,GEMINI_GLOBAL_RPM:10000,GEMINI_DAILY_LIMIT:1000000,GEMINI_INPUT_TPM:10000000};
  for(const [key,limit] of Object.entries(limits)){
    expect(readConfig({...valid,[key]:'1'})).toHaveProperty(key,1);
    expect(readConfig({...valid,[key]:String(limit)})).toHaveProperty(key,limit);
    if(key!=='LLM_RESERVED_INPUT_TOKENS')expect(readConfig({...valid,[key]:'0'})).toHaveProperty(key,0);
    for(const value of [...(key==='LLM_RESERVED_INPUT_TOKENS'?['0']:[]),'-1','1.5','NaN','Infinity','',String(limit+1)])expect(()=>readConfig({...valid,[key]:value})).toThrow(key);
  }
});
it('keeps GEMINI aliases and gives explicit LLM values precedence without ignoring invalid aliases',()=>{
  expect(readConfig({...valid,GEMINI_GLOBAL_RPM:'6'})).toMatchObject({GEMINI_GLOBAL_RPM:6,LLM_GLOBAL_RPM:6});
  expect(readConfig({...valid,GEMINI_GLOBAL_RPM:'6',LLM_GLOBAL_RPM:'10'})).toMatchObject({GEMINI_GLOBAL_RPM:10,LLM_GLOBAL_RPM:10});
  expect(()=>readConfig({...valid,GEMINI_GLOBAL_RPM:'bad',LLM_GLOBAL_RPM:'10'})).toThrow('GEMINI_GLOBAL_RPM');
});

it('parses a deduplicated pool, prefers it over legacy and falls back for empty lists',()=>{
  expect(readConfig({...valid,GEMINI_API_KEYS:' key1, ,key2,key1, key3, '}).GEMINI_API_KEYS).toEqual(['key1','key2','key3']);
  for(const value of ['', ' , , '])expect(readConfig({...valid,GEMINI_API_KEYS:value}).GEMINI_API_KEYS).toEqual([valid.GEMINI_API_KEY]);
  expect(readConfig({...valid,GEMINI_API_KEYS:'AQ.fixture-token,legacy-token'}).GEMINI_API_KEYS).toEqual(['AQ.fixture-token','legacy-token']);
  expect(readConfig({...valid,GEMINI_API_KEYS:'key1',GEMINI_API_KEY:''}).GEMINI_API_KEYS).toEqual(['key1']);
  for(const patch of [{GEMINI_API_KEY:''},{GEMINI_API_KEYS:' , ',GEMINI_API_KEY:''},{GEMINI_API_KEYS:'private invalid key'},{GEMINI_API_KEY:'private invalid key'}]){
    expect(()=>readConfig({...valid,...patch})).toThrow('GEMINI_API_KEY');
    try{readConfig({...valid,...patch});}catch(error){expect(String(error)).not.toContain('private invalid key');}
  }
});
it('gives LLM_LOCAL names precedence over both legacy aliases and validates concurrency',()=>{
  expect(readConfig({...valid,GEMINI_GLOBAL_RPM:'5',LLM_GLOBAL_RPM:'8',LLM_LOCAL_GLOBAL_RPM:'0'})).toMatchObject({LLM_LOCAL_GLOBAL_RPM:0,LLM_GLOBAL_RPM:0,GEMINI_GLOBAL_RPM:0});
  for(const value of ['0','-1','1.5','', 'NaN','33'])expect(()=>readConfig({...valid,LLM_MAX_CONCURRENT_CALLS:value})).toThrow('LLM_MAX_CONCURRENT_CALLS');
  expect(readConfig({...valid,LLM_MAX_CONCURRENT_CALLS:'1'}).LLM_MAX_CONCURRENT_CALLS).toBe(1);
});
