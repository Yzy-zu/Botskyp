import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { db,config,owner,chat,initialize,reset,context,png } from './r4-harness.js';
import { configForChat,routerModeForChat,readConfig } from '../src/config.js';
import { geminiKeyPool } from '../src/core/gemini-key-pool.js';
import { Gemini } from '../src/core/llm.js';
import { receive,processNext } from '../src/core/inbox.js';
import { enqueueMedia } from '../src/modules/media/service.js';
import { claimMedia,processMedia,recoverMedia,type WorkerDeps } from '../src/modules/media/worker.js';
import { reportMediaDeliveries } from '../src/modules/media/delivery.js';
import { sendNext } from '../src/wa/outbox.js';
import type { Transport,Msg } from '../src/wa/types.js';
const other='400@g.us';
const canary={...config,GEMINI_FREE_TIER_CONFIRMED:true,ROUTER_MODE:'v1_1' as const,ROUTER_V1_1_CHAT_IDS:[chat]};
let root:string;
beforeAll(async()=>{await initialize();root=await mkdtemp(join(tmpdir(),'botsky-canary-'));});
beforeEach(async()=>{
  await reset();await db.query('TRUNCATE jobs,media_attachments CASCADE');
  await db.query("UPDATE chats SET settings='{\"modules\":{\"xp\":true,\"media\":true}}' WHERE id=$1",[other]);
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,123)',[owner]);
});
afterAll(async()=>{await rm(root,{recursive:true,force:true});await db.end();});
it('uses only global mode even with a stale allowlist; explicit v1 remains immediate rollback',()=>{
  for(const mode of ['v1','v1_1','v1_1_shadow'] as const){
    const global={...canary,ROUTER_MODE:mode};
    for(const id of [chat,other,owner,'101@lid'])expect(routerModeForChat(global,id)).toBe(mode);
  }
});
it('reuses the root config and one Gemini pool across chats',()=>{
  const view=configForChat(canary,chat);
  expect(view).toBe(canary);expect(configForChat(view,other)).toBe(canary);
  expect(geminiKeyPool(view)).toBe(geminiKeyPool(canary));expect(geminiKeyPool(view).maxConcurrent).toBe(4);
});
it('ignores even malformed deprecated allowlists without an operational dependency',()=>{
  const env={DATABASE_URL:'postgresql://test:test@localhost/test',EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'fixture',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:owner,BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:chat,GEMINI_API_KEY:'fixture-key'};
  for(const legacy of [chat,'','invalid'])expect(readConfig({...env,ROUTER_V1_1_CHAT_IDS:legacy}).ROUTER_MODE).toBe('v1_1');
});
it('uses Gemini and R3 exactly once in Lab, another enabled group and an eligible private chat',async()=>{
  const model=vi.spyOn(Gemini.prototype,'generate').mockResolvedValue({text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:'notes_create',args:{body:'Dato exacto.'}}}]}});
  try{
    for(const chatId of [chat,other,owner]){
      const msg:Msg={id:randomUUID(),chatId,senderId:owner,isGroup:chatId.endsWith('@g.us'),ts:new Date(),text:'bot guarda una nota',fromMe:false,mentions:[],attachments:[]};
      expect(await receive(db,canary,msg)).toBe('accepted');expect(await processNext(db,canary)).toBe(true);
      expect((await db.query("SELECT payload->>'text' text FROM outbox WHERE payload->>'sourceId'=$1",[msg.id])).rows[0]?.text).toContain('Dato exacto.');
      expect((await db.query('SELECT tool_name FROM tool_executions WHERE chat_id=$1',[chatId])).rows).toEqual([{tool_name:'notes.create'}]);
    }
    expect(model).toHaveBeenCalledTimes(3);
  }finally{model.mockRestore();}
});
async function mediaJobs(){
  const result:{id:string;chat_id:string}[]=[];
  for(const chatId of [chat,other]){
    await context({chatId,text:'bot qr prueba'},ctx=>enqueueMedia({...ctx,config:configForChat(canary,chatId)},{operation:'qr_create',text:'prueba'}));
    const job=await claimMedia(db);expect(job).toBeDefined();
    const deps:WorkerDeps={root,download:vi.fn(async()=>{throw new Error('Unexpected download');}),attachment:vi.fn(async()=>({bytes:png,mime:'image/png'})),process:async cwd=>{await writeFile(join(cwd,'result.png'),png);return {files:['result.png']};}};
    await processMedia(db,canary,job!,deps);result.push(job!);
  }
  return result;
}
it('scopes media processing, artifacts and outbox presentation by the originating chat',async()=>{
  await mediaJobs();
  expect((await db.query('SELECT chat_id FROM chat_artifacts ORDER BY chat_id')).rows).toEqual([{chat_id:chat},{chat_id:other}]);
  const replies=(await db.query("SELECT chat_id,payload->>'text' text FROM outbox WHERE kind='media_result' ORDER BY id")).rows;
  expect(replies[0]?.text).toContain('Listo');expect(replies[1]?.text).toContain('Listo');
  const transport:Transport={state:async()=>true,reconcile:async()=>({status:'unknown'}),send:vi.fn(async()=>({status:'sent' as const,id:randomUUID()}))};
  expect(await sendNext(db,transport,canary)).toBe(true);expect(await sendNext(db,transport,canary)).toBe(true);
  expect(transport.send).toHaveBeenCalledTimes(2);
});
it('scopes recovery and delivery-failure notifications without global v1.1 leakage',async()=>{
  await mediaJobs();
  await db.query("UPDATE jobs SET status='running',attempts=3 WHERE kind='media'");
  await recoverMedia(db,canary);
  const recovery=(await db.query("SELECT chat_id,payload->>'text' text FROM outbox WHERE dedupe_key LIKE 'media:result:%:error' ORDER BY id")).rows;
  expect(recovery.find(r=>r.chat_id===chat)?.text).not.toContain('Trabajo #');
  expect(recovery.find(r=>r.chat_id===other)?.text).not.toContain('Trabajo #');
  await db.query("UPDATE jobs SET status='done'; UPDATE outbox SET status='failed' WHERE kind='media_result'");
  await reportMediaDeliveries(db,canary);
  const delivery=(await db.query("SELECT chat_id,payload->>'text' text FROM outbox WHERE dedupe_key LIKE 'media:delivery-problem:%'")).rows;
  expect(delivery.find(r=>r.chat_id===chat)?.text).not.toContain('Trabajo #');
  expect(delivery.find(r=>r.chat_id===other)?.text).not.toContain('Trabajo #');
});
