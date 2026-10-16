import { readFileSync } from 'node:fs';
import { beforeAll,afterAll,beforeEach,describe,it,expect } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { receive,processNext } from '../src/core/inbox.js';
import { sendNext,recoverSending } from '../src/wa/outbox.js';
import { MockEvolution } from '../src/wa/mock.js';
import { makeApp } from '../src/app.js';
import { msgSchema,type Msg } from '../src/wa/types.js';
import { normalizeData } from '../src/wa/normalize.js';
import { product } from '../config/product.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
if (!new URL(url).pathname.startsWith('/botsky_test_')) throw new Error('Tests require isolated database');
const db=createDb(url);
const config=readConfig({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net,222@lid',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'});
const msg=(id='one',overrides:Partial<Msg>={}):Msg=>({id,chatId:config.LAB_CHAT_ID,senderId:'100@s.whatsapp.net',isGroup:true,ts:new Date(),text:'bot ping',fromMe:false,mentions:[],attachments:[],...overrides});
async function clearGap():Promise<void>{await db.query("UPDATE outbox SET sending_at=NULL,next_try_at=now()-interval '1 second'");}
async function drain(mock:MockEvolution):Promise<void>{while(await processNext(db,config)){ /* Drain persisted inbox in arrival order. */ }for(let i=0;i<50;i++){await clearGap();if(!await sendNext(db,mock,config))break;}}
beforeAll(()=>migrate(db));
afterAll(()=>db.end());
beforeEach(async()=>{
  await db.query('TRUNCATE inbox,seen_events,outbox,chats,group_memberships,users,user_aliases,error_log,system_flags CASCADE');
  await db.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,true,true)',[config.LAB_CHAT_ID]);
});
describe('persistent pipeline',()=>{
  it('replays a captured REST message through the persistent pipeline and mock provider',async()=>{
    const fixture=JSON.parse(readFileSync('tests/fixtures/history.json','utf8')) as {messages:{records:{message:{conversation?:string}}[]}};
    const event=normalizeData(fixture.messages.records.find(r=>r.message.conversation==='bot ping'));
    if(event?.kind!=='message')throw new Error('Captured ping unavailable');
    // Fixture replay runs at the original event time. Production never rewrites timestamps.
    expect(await receive(db,config,event.message,event.message.ts)).toBe('accepted');
    expect(await receive(db,config,{...event.message,id:'old-replay'})).toBe('ignored');
    const mock=new MockEvolution();await drain(mock);
    expect([...mock.deliveries.values()][0]?.delivery.text).toBe('pong');
  });
  it('receives duplicate webhooks concurrently and emits once',async()=>{
    const results=await Promise.all(Array.from({length:12},()=>receive(db,config,msg())));
    expect(results.filter(x=>x==='accepted')).toHaveLength(1);
    const mock=new MockEvolution();await drain(mock);expect(mock.deliveries.size).toBe(1);
  });
  it('ignores old reconnect backlog, future, own and real-group events',async()=>{
    for(const input of [msg('old',{ts:new Date(Date.now()-121000)}),msg('future',{ts:new Date(Date.now()+31000)}),msg('own',{fromMe:true}),msg('real',{chatId:'999@g.us'})]) expect(await receive(db,config,input)).toBe('ignored');
    expect((await db.query('SELECT * FROM inbox')).rowCount).toBe(0);
  });
  it('disabled chat remains silent; unresolved LID cannot enable it',async()=>{
    await db.query('UPDATE chats SET enabled=false');
    await receive(db,config,msg('x',{senderId:'123@lid',text:'bot habilita aquí'}));
    await receive(db,config,msg('y'));const mock=new MockEvolution();await drain(mock);expect(mock.deliveries.size).toBe(0);
    await receive(db,config,msg('owner',{text:'bot habilita aquí'}));await drain(mock);expect(mock.deliveries.size).toBe(1);
  });
  it('resolves owner aliases only from stored evidence',async()=>{
    await db.query('UPDATE chats SET enabled=false');
    await db.query("INSERT INTO users(id) VALUES('100@s.whatsapp.net')");
    await db.query("INSERT INTO user_aliases(alias,user_id,evidence) VALUES('123@lid','100@s.whatsapp.net','provider_participants')");
    await receive(db,config,msg('lid',{senderId:'123@lid',text:'bot habilita aquí'}));const mock=new MockEvolution();await drain(mock);expect(mock.deliveries.size).toBe(1);
  });
  it('a suspended alias cannot inherit owner privileges',async()=>{
    await db.query('UPDATE chats SET enabled=false');
    await db.query("INSERT INTO users(id) VALUES('100@s.whatsapp.net')");
    await db.query("INSERT INTO user_aliases(alias,user_id,evidence) VALUES('123@lid','100@s.whatsapp.net','conflict:999@s.whatsapp.net')");
    await receive(db,config,msg('suspended',{senderId:'123@lid',text:'bot habilita aquí'}));
    const mock=new MockEvolution();await drain(mock);expect(mock.deliveries.size).toBe(0);
  });
  it('private strangers are silent; owner and current members can ping',async()=>{
    await receive(db,config,msg('stranger',{isGroup:false,chatId:'400@s.whatsapp.net',senderId:'400@s.whatsapp.net',text:'ping'}));
    await receive(db,config,msg('owner',{isGroup:false,chatId:'100@s.whatsapp.net',text:'ping'}));
    await db.query("INSERT INTO users(id) VALUES('500@s.whatsapp.net')");
    await db.query("INSERT INTO group_memberships(chat_id,user_id) VALUES($1,'500@s.whatsapp.net')",[config.LAB_CHAT_ID]);
    await receive(db,config,msg('member',{isGroup:false,chatId:'500@s.whatsapp.net',senderId:'500@s.whatsapp.net',text:'ping'}));
    const mock=new MockEvolution();await drain(mock);expect(mock.deliveries.size).toBe(2);
    await db.query('UPDATE group_memberships SET active=false');
    await receive(db,config,msg('exmember',{isGroup:false,chatId:'500@s.whatsapp.net',senderId:'500@s.whatsapp.net',text:'ping'}));
    await drain(mock);expect(mock.deliveries.size).toBe(2);
  });
  it('a burst survives connection restart and dedupe replay',async()=>{
    const inputs=Array.from({length:20},(_,i)=>msg(`burst-${i}`));
    for(const input of inputs)await receive(db,config,input);
    for(let i=0;i<7;i++)await processNext(db,config);
    const fresh=createDb(url);expect((await fresh.query("SELECT * FROM inbox WHERE status='queued'")).rowCount).toBe(13);await fresh.end();
    for(const input of inputs)expect(await receive(db,config,input)).toBe('duplicate');
    const mock=new MockEvolution();await drain(mock);expect(mock.deliveries.size).toBe(20);
  });
  it('reconciles send accepted before timeout without duplicate',async()=>{
    await receive(db,config,msg());await processNext(db,config);const mock=new MockEvolution();mock.next='timeout-after';
    await sendNext(db,mock,config);await clearGap();await sendNext(db,mock,config);
    expect(mock.deliveries.size).toBe(1);expect((await db.query('SELECT status FROM outbox')).rows[0]?.status).toBe('sent');
  });
  it('recovers interrupted sending; an authoritative absence permits retry',async()=>{
    await receive(db,config,msg());await processNext(db,config);await db.query("UPDATE outbox SET status='sending'");
    await recoverSending(db);const mock=new MockEvolution();await drain(mock);
    expect(mock.deliveries.size).toBe(1);
  });
  it('unknown reconciliation stays uncertain and queues one honest owner alert',async()=>{
    await receive(db,config,msg());await processNext(db,config);const mock=new MockEvolution();mock.next='timeout-before';
    await sendNext(db,mock,config);mock.reconcile=async()=>({status:'unknown'});
    for(let i=0;i<3;i++){await clearGap();await sendNext(db,mock,config);}
    const rows=await db.query('SELECT status,dedupe_key FROM outbox ORDER BY id');
    expect(rows.rows[0]?.status).toBe('uncertain');expect(rows.rows).toHaveLength(2);expect(rows.rows[1]?.dedupe_key).toMatch(/^alert:/);
    expect(mock.deliveries.size).toBe(0);
  });
  it.each([product.maxReconcileAttempts,product.maxReconcileAttempts+1])('sends #2 when earlier #1 is uncertain with %i exhausted reconciliation attempts',async(attempts)=>{
    await receive(db,config,msg('1'));await receive(db,config,msg('2'));
    await processNext(db,config);await processNext(db,config);
    const rows=await db.query<{id:string}>('SELECT id FROM outbox ORDER BY id');
    const first=rows.rows[0]!.id;const second=rows.rows[1]!.id;
    await db.query("UPDATE outbox SET status='uncertain',reconcile_attempts=$2 WHERE id=$1",[first,attempts]);
    const mock=new MockEvolution();expect(await sendNext(db,mock,config)).toBe(true);
    expect([...mock.deliveries.keys()]).toEqual([second]);
    const saved=await db.query('SELECT id,status,reconcile_attempts FROM outbox ORDER BY id');
    expect(saved.rows).toEqual([{id:first,status:'uncertain',reconcile_attempts:attempts},{id:second,status:'sent',reconcile_attempts:0}]);
  });
  it('keeps FIFO blocked while an earlier uncertain message still has reconciliation attempts',async()=>{
    await receive(db,config,msg('1'));await receive(db,config,msg('2'));
    await processNext(db,config);await processNext(db,config);
    await db.query("UPDATE outbox SET status='uncertain',reconcile_attempts=$1,next_try_at=now()+interval '1 hour' WHERE id=(SELECT min(id) FROM outbox)",[product.maxReconcileAttempts-1]);
    const mock=new MockEvolution();expect(await sendNext(db,mock,config)).toBe(false);expect(mock.deliveries.size).toBe(0);
  });
  it('retries only safe transient rejection, terminal failures remain failed',async()=>{
    await receive(db,config,msg());await processNext(db,config);const mock=new MockEvolution();mock.next='retry';
    await sendNext(db,mock,config);expect((await db.query('SELECT status FROM outbox')).rows[0]?.status).toBe('queued');
    await clearGap();mock.next='failed';await sendNext(db,mock,config);
    expect((await db.query('SELECT status FROM outbox')).rows[0]?.status).toBe('failed');expect(mock.deliveries.size).toBe(0);
  });
  it('rate limits each chat and persists emergency stop',async()=>{
    await receive(db,config,msg('1'));await receive(db,config,msg('2'));while(await processNext(db,config)){ /* Drain persisted inbox in arrival order. */ }
    const mock=new MockEvolution();expect(await sendNext(db,mock,config)).toBe(true);expect(await sendNext(db,mock,config)).toBe(false);
    await db.query("INSERT INTO system_flags(key,value) VALUES('emergency','true')");await receive(db,config,msg('3'));await processNext(db,config);
    expect((await db.query('SELECT * FROM outbox')).rowCount).toBe(2);
  });
  it('authenticates webhook and reports provider failure honestly',async()=>{
    const mock=new MockEvolution();const app=makeApp(db,config,mock,input=>msgSchema.parse(input));
    const no=await app.inject({method:'POST',url:'/webhook',payload:msg()});expect(no.statusCode).toBe(401);
    const yes=await app.inject({method:'POST',url:'/webhook',headers:{'x-webhook-secret':config.WEBHOOK_SECRET},payload:msg()});expect(yes.statusCode).toBe(200);
    const invalid=await app.inject({method:'POST',url:'/webhook',headers:{'content-type':'application/json'},payload:'{broken'});expect(invalid.statusCode).toBe(400);
    const oversized=await app.inject({method:'POST',url:'/webhook',headers:{'content-type':'application/json'},payload:'x'.repeat(2_000_001)});expect(oversized.statusCode).toBe(413);
    mock.connected=false;expect((await app.inject({url:'/health'})).statusCode).toBe(503);await app.close();
  });
});
