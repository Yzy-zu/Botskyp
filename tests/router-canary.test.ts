import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { db,config,owner,chat,initialize,reset,context,png } from './r4-harness.js';
import { configForChat,routerModeForChat,readConfig } from '../src/config.js';
import { geminiKeyPool } from '../src/core/gemini-key-pool.js';
import { receive,processNext } from '../src/core/inbox.js';
import { enqueueMedia } from '../src/modules/media/service.js';
import { claimMedia,processMedia,recoverMedia,type WorkerDeps } from '../src/modules/media/worker.js';
import { reportMediaDeliveries } from '../src/modules/media/delivery.js';
import { sendNext } from '../src/wa/outbox.js';
import type { Transport,Msg } from '../src/wa/types.js';
const other='400@g.us';
const canary={...config,ROUTER_MODE:'v1' as const,ROUTER_V1_1_CHAT_IDS:[chat]};
let root:string;
beforeAll(async()=>{await initialize();root=await mkdtemp(join(tmpdir(),'botsky-canary-'));});
beforeEach(async()=>{
  await reset();await db.query('TRUNCATE jobs,media_attachments CASCADE');
  await db.query("UPDATE chats SET settings='{\"modules\":{\"xp\":true,\"media\":true}}' WHERE id=$1",[other]);
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,123)',[owner]);
});
afterAll(async()=>{await rm(root,{recursive:true,force:true});await db.end();});
it('limits v1.1 to the allowlist even when the global mode is v1.1; empty list rolls back all chats',()=>{
  for(const mode of ['v1','v1_1','v1_1_shadow'] as const){
    const scoped={...canary,ROUTER_MODE:mode};
    expect(routerModeForChat(scoped,chat)).toBe('v1_1');
    for(const id of [other,owner,'101@lid'])expect(routerModeForChat(scoped,id)).toBe('v1');
    expect(routerModeForChat({...scoped,ROUTER_V1_1_CHAT_IDS:[]},chat)).toBe('v1');
  }
  expect(routerModeForChat(config,chat)).toBe('v1_1');
});
it('reuses mode views and one Gemini pool with one concurrency bound across chats',()=>{
  const view=configForChat(canary,chat);
  expect(configForChat(canary,chat)).toBe(view);
  expect(configForChat(view,other)).toBe(canary);
  expect(geminiKeyPool(view)).toBe(geminiKeyPool(canary));
  expect(geminiKeyPool(view).maxConcurrent).toBe(4);
});
it('validates and deduplicates the allowlist without reflecting invalid IDs',()=>{
  const env={DATABASE_URL:'postgresql://test:test@localhost/test',EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'fixture',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:owner,BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:chat,GEMINI_API_KEY:'fixture-key'};
  expect(readConfig({...env,ROUTER_V1_1_CHAT_IDS:` ${chat},,${chat} `}).ROUTER_V1_1_CHAT_IDS).toEqual([chat]);
  expect(readConfig({...env,ROUTER_V1_1_CHAT_IDS:''}).ROUTER_V1_1_CHAT_IDS).toEqual([]);
  expect(()=>readConfig({...env,ROUTER_V1_1_CHAT_IDS:'private-invalid-id'})).toThrow('ROUTER_V1_1_CHAT_IDS');
});
it('processes Lab through R3 exactly once and another enabled group through legacy without R3 effects',async()=>{
  for(const chatId of [chat,other]){
    const msg:Msg={id:randomUUID(),chatId,senderId:owner,isGroup:true,ts:new Date(),text:'bot xp',fromMe:false,mentions:[],attachments:[]};
    expect(await receive(db,canary,msg)).toBe('accepted');expect(await processNext(db,canary)).toBe(true);
    const reply=(await db.query("SELECT payload->>'text' text FROM outbox WHERE payload->>'sourceId'=$1",[msg.id])).rows[0]?.text as string;
    expect(reply).toContain('XP');
    expect((await db.query('SELECT tool_name FROM tool_executions WHERE chat_id=$1',[chatId])).rows).toEqual(chatId===chat?[{tool_name:'xp.balance'}]:[]);
  }
  expect((await db.query('SELECT count(*)::int n FROM llm_usage')).rows[0]?.n ?? 0).toBe(0);
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
  expect((await db.query('SELECT chat_id FROM chat_artifacts')).rows).toEqual([{chat_id:chat}]);
  const replies=(await db.query("SELECT chat_id,payload->>'text' text FROM outbox WHERE kind='media_result' ORDER BY id")).rows;
  expect(replies[0]?.text).toContain('Listo');expect(replies[1]?.text).toContain('Resultado del trabajo #');
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
  expect(recovery.find(r=>r.chat_id===other)?.text).toContain('Trabajo #');
  await db.query("UPDATE jobs SET status='done'; UPDATE outbox SET status='failed' WHERE kind='media_result'");
  await reportMediaDeliveries(db,canary);
  const delivery=(await db.query("SELECT chat_id,payload->>'text' text FROM outbox WHERE dedupe_key LIKE 'media:delivery-problem:%'")).rows;
  expect(delivery.find(r=>r.chat_id===chat)?.text).not.toContain('Trabajo #');
  expect(delivery.find(r=>r.chat_id===other)?.text).toContain('Trabajo #');
});
