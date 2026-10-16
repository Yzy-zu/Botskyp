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
