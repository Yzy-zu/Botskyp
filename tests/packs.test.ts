import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { transaction } from '../src/db/client.js';
import { moveXp } from '../src/modules/xp/service.js';
import { purchase,type Order } from '../src/modules/packs/orders.js';
import { settleOrders } from '../src/modules/packs/delivery.js';
import { publish } from '../src/modules/library/catalog.js';
import { sendNext,recoverSending } from '../src/wa/outbox.js';
import { receive,processNext } from '../src/core/inbox.js';
import { createRegistry } from '../src/core/registry.js';
import type { Transport,Delivery,SendResult } from '../src/wa/types.js';
import { product } from '../config/product.js';
import { db,config,owner,member,admin,message,initialize,resetSchool,context,command,execute } from './school-harness.js';
import { seedLibrary,libraryFiles } from './library-harness.js';
beforeAll(initialize);beforeEach(async()=>{await resetSchool();await db.query('TRUNCATE wallets CASCADE');await seedLibrary();for(const user of [owner,member,admin])await transaction(db,c=>moveXp(c,user,1000,'seed',user,config.LAB_CHAT_ID));});afterAll(()=>db.end());
const buy=(sender=member,input=message('bot pack',sender),category?:string)=>context(input,ctx=>purchase(ctx,category));
const orders=async()=>(await db.query<Order>('SELECT * FROM pack_orders ORDER BY created_at')).rows;
const balance=async(user=member)=>(await db.query<{balance:number}>('SELECT balance FROM wallets WHERE user_id=$1',[user])).rows[0]!.balance;
const deliveries:Delivery[]=[];
function transport(result:SendResult={status:'sent',id:'confirmed'}):Transport{return {state:async()=>true,send:async d=>{deliveries.push(d);return result;},reconcile:async()=>({status:'unknown'})};}
async function drain(t=transport()){
  for(let i=0;i<20;i++){
    await db.query('UPDATE outbox SET sending_at=NULL,next_try_at=now()');
    if(!await sendNext(db,t,config))break;
  }
  await settleOrders(db,config);
}
it('a purchase reserves exact price, sends only privately and confirms after every provider receipt',async()=>{
  deliveries.length=0;expect(await buy()).toContain('aún no confirmada');expect(await balance()).toBe(850);expect((await orders())[0]?.status).toBe('queued');
  await drain();expect((await orders())[0]?.status).toBe('confirmed');const files=deliveries.filter(d=>d.media);expect(files.length).toBeGreaterThanOrEqual(3);expect(files.length).toBeLessThanOrEqual(5);expect(files.every(d=>d.chatId===member && d.sourceId==='' && d.media?.mime==='text/plain')).toBe(true);
  expect((await db.query('SELECT * FROM library_events')).rowCount).toBeGreaterThanOrEqual(3);
});
it('simultaneous purchases cannot overdraw the global wallet',async()=>{
  await db.query('UPDATE wallets SET balance=150 WHERE user_id=$1',[member]);const results=await Promise.allSettled([buy(),buy()]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance()).toBe(0);expect(await orders()).toHaveLength(1);
});
it('concurrent replay of one purchase creates one debit and one delivery set',async()=>{
  const m=message('bot pack',member);await Promise.all([buy(member,m),buy(member,m)]);expect(await balance()).toBe(850);expect(await orders()).toHaveLength(1);
  const n=(await db.query('SELECT * FROM pack_order_items')).rowCount;expect((await db.query("SELECT * FROM outbox WHERE kind='library_item'")).rowCount).toBe(n);
});
it('double authenticated webhook creates one order and one reserve',async()=>{
  const m=message('bot pack',member);await receive(db,config,m);expect(await receive(db,config,m)).toBe('duplicate');await processNext(db,config);await processNext(db,config);
  expect(await orders()).toHaveLength(1);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='pack_reserve'")).rowCount).toBe(1);
});
it('insufficient balance rolls back the whole reservation',async()=>{
  await db.query('UPDATE wallets SET balance=149 WHERE user_id=$1',[member]);await expect(buy()).rejects.toThrow('suficiente');expect(await orders()).toHaveLength(0);expect(await balance()).toBe(149);
});
it('nonexistent category and empty stock never charge',async()=>{
  await expect(buy(member,undefined,'NoExiste')).rejects.toThrow('suficientes');await db.query('UPDATE library_items SET enabled=false');await expect(buy()).rejects.toThrow('suficientes');expect(await balance()).toBe(1000);
});
it('missing or corrupted bytes before reservation never charge',async()=>{
  await db.query('UPDATE library_blobs SET data=decode(repeat(\'00\',size),\'hex\')');await expect(buy()).rejects.toThrow('segura');expect(await balance()).toBe(1000);expect(await orders()).toHaveLength(0);
});
it('deleting or changing source after reservation cannot change purchased bytes',async()=>{
  deliveries.length=0;await buy();const snapshots=(await db.query('SELECT sha256 FROM pack_order_items ORDER BY position')).rows;
  await transaction(db,c=>publish(c,'local',[]));await transaction(db,c=>publish(c,'local',libraryFiles(8,'Otra')));await drain();
  expect((await orders())[0]?.status).toBe('confirmed');expect((await db.query('SELECT sha256 FROM pack_order_items ORDER BY position')).rows).toEqual(snapshots);expect(deliveries.filter(d=>d.media).every(d=>Buffer.from(d.media!.base64,'base64').toString().includes('Memes'))).toBe(true);
});
it('definite delivery failure refunds 100 percent once and stops remaining files',async()=>{
  await buy();await drain(transport({status:'failed',reason:'rejected'}));expect((await orders())[0]?.status).toBe('refunded');expect(await balance()).toBe(1000);
  await settleOrders(db,config);await drain();expect(await balance()).toBe(1000);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='pack_refund'")).rowCount).toBe(1);
});
it('uncertain delivery retains reserve in pending_review and never sends the same file again',async()=>{
  deliveries.length=0;await buy();await drain(transport({status:'uncertain',reason:'timeout'}));expect((await orders())[0]?.status).toBe('pending_review');expect(await balance()).toBe(850);expect(deliveries.filter(d=>d.media)).toHaveLength(1);
  await drain();expect(deliveries.filter(d=>d.media)).toHaveLength(1);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='pack_refund'")).rowCount).toBe(0);
});
it('partial delivery followed by failure requires review and cannot refund a received pack',async()=>{
  deliveries.length=0;let files=0;const t=transport();t.send=async d=>{deliveries.push(d);return {status:++files===1?'sent':'failed',id:'ok',reason:'rejected'};};
  await buy();await drain(t);expect((await orders())[0]?.status).toBe('pending_review');expect(await balance()).toBe(850);expect(deliveries.filter(d=>d.media)).toHaveLength(2);
});
it('missing bytes after reservation fail delivery and safely refund without any sends',async()=>{
  deliveries.length=0;await buy();await db.query('UPDATE library_blobs SET data=decode(repeat(\'00\',size),\'hex\')');await drain();expect(deliveries.filter(d=>d.media)).toHaveLength(0);expect(await balance()).toBe(1000);
});
it('restart during sending becomes uncertain and does not replay a file',async()=>{
  deliveries.length=0;await buy();await db.query("UPDATE outbox SET status='sending' WHERE id=(SELECT min(id) FROM outbox)");await recoverSending(db);await drain();expect(deliveries.filter(d=>d.media)).toHaveLength(0);expect((await orders())[0]?.status).toBe('pending_review');
});
it('a confirmed provider message id reconciles without a second transport send',async()=>{
  await buy();const t=transport();let called=0;t.send=async()=>{called++;return {status:'uncertain',reason:'timeout'};};
  await sendNext(db,t,config);t.reconcile=async()=>({status:'found',id:'real-evidence'});await db.query('UPDATE outbox SET next_try_at=now(),sending_at=NULL');await sendNext(db,t,config);
  expect(called).toBe(1);expect((await db.query("SELECT * FROM outbox WHERE provider_msg_id='real-evidence' AND status='sent'")).rowCount).toBe(1);
});
it('repeated ticks and outbox replays never duplicate successful sends',async()=>{
  deliveries.length=0;await buy();await drain();const n=deliveries.filter(d=>d.media).length;await drain();await drain();expect(deliveries.filter(d=>d.media)).toHaveLength(n);expect((await orders())[0]?.status).toBe('confirmed');
});
it('happy hour price and size use backend settings and exact configured bounds',async()=>{
  await db.query("UPDATE chats SET settings=jsonb_build_object('happy_hour_until',(now()+interval '1 hour')::text) WHERE id=$1",[config.LAB_CHAT_ID]);await buy();const order=(await orders())[0]!;
  expect(order.price).toBe(75);const n=(await db.query('SELECT * FROM pack_order_items')).rowCount!;expect(n).toBeGreaterThanOrEqual(product.packHappyMinItems);expect(n).toBeLessThanOrEqual(product.packHappyMaxItems);expect(await balance()).toBe(925);
});
it('happy hour requires at least four available elements and never charges for three',async()=>{
  await db.query("UPDATE chats SET settings=jsonb_build_object('happy_hour_until',(now()+interval '1 hour')::text)");await transaction(db,c=>publish(c,'local',libraryFiles(3)));await expect(buy()).rejects.toThrow('suficientes');expect(await balance()).toBe(1000);
});
it('private chat disabled before purchase prevents any debit',async()=>{
  await db.query('INSERT INTO chats(id,is_group,enabled) VALUES($1,false,false)',[member]);await expect(buy()).rejects.toThrow('autorizada');expect(await balance()).toBe(1000);
});
it('membership or module revoked before sending fails safely and releases reserve',async()=>{
  await buy();await db.query('UPDATE group_memberships SET active=false WHERE user_id=$1',[member]);await drain();expect(await balance()).toBe(1000);expect((await orders())[0]?.status).toBe('refunded');
});
it('administration and economic tools cannot be invoked by Gemini or inject recipients, prices or paths',async()=>{
  await context(message('bot pack',member),async ctx=>{const r=createRegistry();expect(r.declarations(ctx).some(d=>/packs_|cooperacha_|library_sync|library_rain/.test(d.name))).toBe(false);expect((await r.execute(ctx,'packs.buy',{},'model')).ok).toBe(false);});
  for(const args of [{price:1},{actorId:owner},{destination:config.LAB_CHAT_ID},{category:'../secret'},{path:'/etc/passwd'}])expect((await execute('packs.buy',args,member)).ok).toBe(false);
  expect((await execute('library.sync',{source:'local'},admin)).ok).toBe(false);expect((await execute('cooperacha.open',{},member)).ok).toBe(false);
});
it('deterministic commands work without Gemini and never expose internal paths',async()=>{
  expect(await command('bot biblioteca',member)).toContain('Memes');expect(await command('bot pack Memes',member)).toContain('Entrega privada');expect(await command('bot packs',member)).toContain('queued');expect(await command('bot biblioteca actualizar drive')).toContain('no está configurado');
});
it('private purchase accepts only an eligible canonical actor; other groups require explicit library activation',async()=>{
  expect(await command(message('bot pack',owner,'400@g.us'))).toBe('No.');const m=message('bot pack',owner,owner);await buy(owner,m);expect((await orders())[0]?.destination).toBe(owner);
});
it('library snapshots survive expired multimedia retention',async()=>{
  const { retainMedia }=await import('../src/modules/media/worker.js');await db.query("UPDATE library_blobs SET created_at=now()-interval '100 days'");await retainMedia(db);await buy();await drain();expect((await orders())[0]?.status).toBe('confirmed');
});
it('private library disabled before purchase or delivery prevents charging or refunds safely',async()=>{
  await db.query('INSERT INTO chats(id,is_group,enabled,settings) VALUES($1,false,true,$2)',[member,JSON.stringify({modules:{library:false}})]);await expect(buy()).rejects.toThrow('autorizada');expect(await balance()).toBe(1000);
  await db.query("UPDATE chats SET settings='{}' WHERE id=$1",[member]);await buy();await db.query('UPDATE chats SET settings=$2 WHERE id=$1',[member,JSON.stringify({modules:{library:false}})]);await drain();expect(await balance()).toBe(1000);
});
it('two releases with stale reserved state cannot create a second release or delivery set',async()=>{
  const { release }=await import('../src/modules/packs/orders.js');await buy();const order=(await orders())[0]!;
  await Promise.all([1,2].map(()=>transaction(db,c=>release(c,{...order,status:'reserved'},member))));
  expect((await db.query("SELECT * FROM library_events WHERE action='released'")).rowCount).toBe(1);expect((await db.query('SELECT * FROM outbox')).rowCount).toBe((await db.query('SELECT * FROM pack_order_items')).rowCount);
});

it('a manipulated group recipient cannot redirect a purchased pack away from the buyer',async()=>{
  deliveries.length=0;await buy();await db.query("UPDATE outbox SET chat_id=$1 WHERE kind='library_item'",[config.LAB_CHAT_ID]);await drain();expect(deliveries.filter(d=>d.media)).toHaveLength(0);expect(await balance()).toBe(1000);
});
it('a crash after reserving bytes, funds and deliveries rolls back every local effect',async()=>{
  await expect(context(message('bot pack',member),async ctx=>{await purchase(ctx);throw new Error('crash-before-commit');})).rejects.toThrow('crash-before-commit');
  expect(await balance()).toBe(1000);expect(await orders()).toHaveLength(0);expect((await db.query('SELECT * FROM outbox')).rowCount).toBe(0);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='pack_reserve'")).rowCount).toBe(0);
});
it('purchases from group and private concurrently share one global wallet',async()=>{
  await db.query('UPDATE wallets SET balance=150 WHERE user_id=$1',[owner]);const results=await Promise.allSettled([buy(owner,message('bot pack',owner)),buy(owner,message('bot pack',owner,owner))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance(owner)).toBe(0);expect(await orders()).toHaveLength(1);
});
it('many old uncertain packs never starve refunds or confirmation of new orders',async()=>{
  await db.query('UPDATE wallets SET balance=10000 WHERE user_id=$1',[member]);
  for(let i=0;i<31;i++)await buy();
  await db.query("UPDATE pack_orders SET status='pending_review'");await db.query("UPDATE outbox SET status='uncertain'");await buy();
  const latest=(await orders()).at(-1)!;await db.query("UPDATE outbox SET status='failed' WHERE payload->>'orderId'=$1",[latest.id]);
  await settleOrders(db,config);expect((await db.query('SELECT status FROM pack_orders WHERE id=$1',[latest.id])).rows[0]?.status).toBe('refunded');expect(await balance()).toBe(10000-31*150);
});
