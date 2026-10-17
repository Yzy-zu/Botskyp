import { expect,it } from 'vitest';
import { readConfig } from '../src/config.js';
const valid={DATABASE_URL:'postgresql://botsky:private-password@botsky-db:5432/botsky',EVOLUTION_URL:'http://evolution_api:8080',EVOLUTION_APIKEY:'private-api-key',INSTANCE:'botsky',WEBHOOK_SECRET:'s'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'evolution'};
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
it('keeps current local quota defaults and only accepts safe reductions in R1',()=>{
  expect(readConfig(valid)).toMatchObject({GEMINI_USER_RPM:8,GEMINI_GLOBAL_RPM:5,GEMINI_DAILY_LIMIT:20,GEMINI_INPUT_TPM:65536});
  for(const [key,limit] of Object.entries({GEMINI_USER_RPM:8,GEMINI_GLOBAL_RPM:5,GEMINI_DAILY_LIMIT:20,GEMINI_INPUT_TPM:65536})){
    expect(readConfig({...valid,[key]:'1'})).toHaveProperty(key,1);
    for(const value of ['0','-1','1.5','NaN',String(limit+1)])expect(()=>readConfig({...valid,[key]:value})).toThrow(key);
  }
});
