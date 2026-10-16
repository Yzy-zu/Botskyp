import { readFileSync } from 'node:fs';
import { it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { makeApp } from '../src/app.js';
import { MockEvolution } from '../src/wa/mock.js';
import { syncLabMembers } from '../src/core/membership.js';
import { startMembershipRefresh } from '../src/core/membership-refresh.js';
import { product } from '../config/product.js';

it('listens with Evolution unavailable, reports degraded health and later syncs members',async()=>{
  const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
  const db=createDb(url);
  const config={...readConfig({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'}),TRANSPORT:'evolution' as const};
  const transport=new MockEvolution();transport.connected=false;
  const app=makeApp(db,config,transport,()=>null);
  const warning=vi.spyOn(app.log,'warn');
  let stop:(()=>void)|undefined;
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try {
    await migrate(db);
    await db.query('TRUNCATE group_memberships,user_aliases,users,chats CASCADE');
    const snapshot:unknown=JSON.parse(readFileSync('tests/fixtures/participants.json','utf8'));
    stop=await startMembershipRefresh(async()=>{
      if(!transport.connected)throw new Error('Provider unavailable');
      await syncLabMembers(db,config.LAB_CHAT_ID,snapshot);
    },app.log);
    expect(warning).toHaveBeenCalledOnce();
    const address=await app.listen({host:'127.0.0.1',port:0});
    const degraded=await fetch(`${address}/health`);
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toEqual({ok:false,database:true,evolution:false,transport:'evolution'});
    transport.connected=true;
    await vi.advanceTimersByTimeAsync(product.membershipRefreshMs);
    const memberships=await db.query('SELECT user_id FROM group_memberships WHERE active=true');
    expect(memberships.rowCount).toBe(2);
    const recovered=await fetch(`${address}/health`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ok:true,database:true,evolution:true,transport:'evolution'});
  } finally {
    stop?.();await app.close();await db.end();vi.useRealTimers();vi.restoreAllMocks();
  }
});
