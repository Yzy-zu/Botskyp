import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { transaction } from '../src/db/client.js';
import { moveXp } from '../src/modules/xp/service.js';
import { openCooperacha,contribute,cancelCooperacha,tickCooperachas,type Cooperacha } from '../src/modules/packs/cooperacha.js';
import { settleOrders } from '../src/modules/packs/delivery.js';
import { sendNext } from '../src/wa/outbox.js';
import { gameCommand } from '../src/modules/games/service.js';
import { tickGames } from '../src/modules/games/tick.js';
import { tickRain,configureRain } from '../src/modules/packs/rain.js';
import { tickSchool } from '../src/modules/school/automation.js';
import { db,config,owner,member,admin,message,initialize,resetSchool,context,command,execute } from './school-harness.js';
import { seedLibrary } from './library-harness.js';
beforeAll(initialize);beforeEach(async()=>{await resetSchool();await db.query('TRUNCATE wallets CASCADE');await seedLibrary();for(const user of [owner,member,admin])await transaction(db,c=>moveXp(c,user,1000,'seed',user,config.LAB_CHAT_ID));});afterAll(()=>db.end());
const open=(goal?:number)=>context(message('bot cooperacha'),ctx=>openCooperacha(ctx,goal));
const add=(amount:number,user=member,input=message('bot aporto',user))=>context(input,ctx=>contribute(ctx,amount));
const cancel=(user=owner)=>context(message('bot cancelar',user),cancelCooperacha);
const balance=async(user=member)=>(await db.query<{balance:number}>('SELECT balance FROM wallets WHERE user_id=$1',[user])).rows[0]?.balance ?? 0;
const co=async()=>(await db.query<Cooperacha>('SELECT * FROM cooperachas ORDER BY created_at DESC LIMIT 1')).rows[0]!;
const expire=()=>db.query("UPDATE cooperachas SET expires_at=now()-interval '1 second'");
it('announces expiry retention and reserves stock before accepting contributions',async()=>{
  expect(await open()).toContain('80 %');expect((await co()).goal).toBe(500);expect((await db.query("SELECT * FROM pack_orders WHERE status='reserved'")).rowCount).toBe(1);expect((await db.query('SELECT * FROM outbox')).rowCount).toBe(0);
});
it('missing pack stock prevents opening and accepting money',async()=>{
  await db.query('UPDATE library_items SET enabled=false');await expect(open()).rejects.toThrow('suficientes');await expect(add(1)).rejects.toThrow('abierta');expect(await balance()).toBe(1000);expect((await db.query('SELECT * FROM cooperachas')).rowCount).toBe(0);
});
it('one open activity per group with replay-safe opening',async()=>{
  const m=message('bot cooperacha');await context(m,ctx=>openCooperacha(ctx));await context(m,ctx=>openCooperacha(ctx));await expect(open()).rejects.toThrow('activa');expect((await db.query('SELECT * FROM cooperachas')).rowCount).toBe(1);
});
it('concurrent contributions atomically accumulate without losing updates',async()=>{
  await open();await Promise.all([add(123),add(201,admin)]);expect((await co()).total).toBe(324);expect(await balance()).toBe(877);expect(await balance(admin)).toBe(799);
});
it('two simultaneous finishers are capped to the remainder and release exactly once',async()=>{
  await open();await Promise.all([add(300),add(300,admin)]);expect(await balance()+await balance(admin)).toBe(1500);expect((await co()).total).toBe(500);expect((await co()).status).toBe('completed');expect(await balance('system:community')).toBe(500);
  expect((await db.query("SELECT * FROM outbox WHERE dedupe_key LIKE 'cooperacha:release:%'")).rowCount).toBe(1);
  expect((await db.query("SELECT * FROM xp_ledger WHERE reason='cooperacha_success'")).rowCount).toBe(1);
});
it('a third finisher cannot debit after the goal has been reached',async()=>{
  await open(50);const result=await Promise.allSettled([add(50),add(50,admin)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance()+await balance(admin)).toBe(1950);
});
it('concurrent duplicate contribution only debits once',async()=>{
  await open();const m=message('bot aporto',member);await Promise.all([add(100,member,m),add(100,member,m)]);expect(await balance()).toBe(900);expect((await co()).total).toBe(100);expect((await db.query('SELECT * FROM cooperacha_contributions')).rowCount).toBe(1);
});
it('an old contribution replay cannot spend again in a new cooperacha',async()=>{
  await open();const m=message('bot aporto',member);await add(100,member,m);await cancel();await open();await add(100,member,m);expect((await co()).total).toBe(0);expect(await balance()).toBe(1000);
});
it('invalid, excessive and insufficient contributions never cause negative wallets',async()=>{
  await open();for(const amount of [0,-1,0.5,NaN])await expect(add(amount)).rejects.toThrow('positiva');await db.query('UPDATE wallets SET balance=20 WHERE user_id=$1',[member]);await expect(add(21)).rejects.toThrow('suficiente');expect((await co()).total).toBe(0);expect(await balance()).toBe(20);
});
it('an overlarge request only charges the remaining goal',async()=>{
  await open(50);expect(await add(1000)).toContain('50 XP');expect(await balance()).toBe(950);expect((await co()).total).toBe(50);
});
it('administrative cancellation returns 100 percent once and cancels reserved reward',async()=>{
  await open();await add(123);await add(201,admin);await cancel();await expect(cancel()).rejects.toThrow('abierta');await tickCooperachas(db);expect(await balance()).toBe(1000);expect(await balance(admin)).toBe(1000);expect(await balance('system:community')).toBe(0);expect((await co()).status).toBe('cancelled');expect((await db.query("SELECT * FROM pack_orders WHERE status='cancelled'")).rowCount).toBe(1);
});
it('expiry returns floor(80 percent) per contribution and credits every remainder to community once',async()=>{
  await open();await add(101);await add(7,admin);await expire();await Promise.all([tickCooperachas(db),tickCooperachas(db)]);expect(await balance()).toBe(979);expect(await balance(admin)).toBe(998);expect(await balance('system:community')).toBe(23);expect((await co()).status).toBe('expired');
  await tickCooperachas(db);expect(await balance('system:community')).toBe(23);
});
it('expiry and administrative cancellation serialize to one financial outcome',async()=>{
  await open();await add(101);await expire();await Promise.allSettled([cancel(),tickCooperachas(db)]);const state=await co();expect(['cancelled','expired']).toContain(state.status);expect(await balance()+await balance('system:community')).toBe(1000);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='cooperacha_refund'")).rowCount).toBe(1);
});
it('a completed reward is delivered to the group for everyone and never to a contributor private chat',async()=>{
  await open(50);await add(50);const destinations:string[]=[];
  for(let i=0;i<12;i++){await db.query('UPDATE outbox SET sending_at=NULL');if(!await sendNext(db,{state:async()=>true,send:async d=>{if(d.media)destinations.push(d.chatId);return {status:'sent',id:`group-${i}`};},reconcile:async()=>({status:'unknown'})},config))break;}
  await settleOrders(db,config);expect(destinations.length).toBeGreaterThanOrEqual(3);expect(destinations.every(d=>d===config.LAB_CHAT_ID)).toBe(true);expect((await db.query("SELECT * FROM pack_orders WHERE status='confirmed'")).rowCount).toBe(1);
});
it('repeated completion replay and ticks cannot release another reward',async()=>{
  await open(50);const m=message('bot aporto',member);await add(50,member,m);const count=(await db.query("SELECT * FROM outbox WHERE kind='library_item'")).rowCount;
  await add(50,member,m);await tickCooperachas(db);await settleOrders(db,config);expect((await db.query("SELECT * FROM outbox WHERE kind='library_item'")).rowCount).toBe(count);expect(await balance('system:community')).toBe(50);
});
it('failed contribution transaction rolls back wallet, ledger and total together',async()=>{
  await open();await expect(context(message('bot aporto',member),async ctx=>{await contribute(ctx,123);throw new Error('crash');})).rejects.toThrow('crash');expect(await balance()).toBe(1000);expect((await co()).total).toBe(0);expect((await db.query('SELECT * FROM cooperacha_contributions')).rowCount).toBe(0);
});
it('expiry remains owed when library module is disabled, while emergency defers the work',async()=>{
  await open();await add(100);await expire();await execute('control.modules',{module:'library',enabled:false});await db.query("INSERT INTO system_flags(key,value) VALUES('emergency','true')");await tickCooperachas(db);expect((await co()).status).toBe('open');await db.query("UPDATE system_flags SET value='false'");await tickCooperachas(db);expect((await co()).status).toBe('expired');expect(await balance()).toBe(980);
});
it('member cannot manage the activity, another-group admin cannot cancel, model cannot contribute',async()=>{
  expect((await execute('cooperacha.open',{},member)).ok).toBe(false);await open();expect((await execute('cooperacha.cancel',{},member)).ok).toBe(false);expect((await execute('cooperacha.cancel',{},admin,'400@g.us')).ok).toBe(false);
});
it('deterministic commands expose exact goal and contribution status without Gemini',async()=>{
  expect(await command('bot cooperacha abrir 500')).toContain('500 XP');expect(await command('bot aporto 50',member)).toContain('Aporte aceptado');expect(await command('bot cooperacha',member)).toContain('50/500');
});
it('airdrop reserves pack before opening and atomically claims XP plus one private reward',async()=>{
  await context(message('bot airdrop'),ctx=>gameCommand(ctx,{action:'airdrop'}));
  expect((await db.query("SELECT * FROM pack_orders WHERE kind='airdrop' AND status='reserved'")).rowCount).toBe(1);
  const result=await Promise.allSettled([member,admin].map(u=>context(message('bot yoo',u),ctx=>gameCommand(ctx,{action:'claim'}))));expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const order=(await db.query<{destination:string;user_id:string}>('SELECT * FROM pack_orders')).rows[0]!;expect([member,admin]).toContain(order.destination);expect(order.destination).toBe(order.user_id);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='airdrop'")).rowCount).toBe(1);
});
it('airdrop with no pack cannot announce a nonexistent reward or mint XP',async()=>{
  await db.query('UPDATE library_items SET enabled=false');await expect(context(message('bot airdrop'),ctx=>gameCommand(ctx,{action:'airdrop'}))).rejects.toThrow('suficientes');expect((await db.query('SELECT * FROM games')).rowCount).toBe(0);
});
it('airdrop expiry cancels its reserved pack without delivery',async()=>{
  await context(message('bot airdrop'),ctx=>gameCommand(ctx,{action:'airdrop'}));await db.query("UPDATE games SET expires_at=now()-interval '1 second'");await tickGames(db,config);expect((await db.query("SELECT * FROM pack_orders WHERE status='cancelled'")).rowCount).toBe(1);
});
it('rain is explicitly off until configured and members cannot configure it',async()=>{
  await tickRain(db,config);expect((await db.query('SELECT * FROM automations')).rowCount).toBe(0);expect((await execute('library.rain',{enabled:true,config:{schedule:{days:[1],time:'18:00'},count:2}},member)).ok).toBe(false);
});
it('rain and school settings stay separate and school tick cannot consume rain',async()=>{
  await execute('school.summary_configure',{enabled:true,schedule:{days:[1],time:'07:00'}});
  await context(message('bot lluvia'),ctx=>configureRain(ctx,true,{schedule:{days:[1],time:'18:00'},count:2}));
  await execute('school.summary_configure',{enabled:false});expect((await db.query("SELECT enabled FROM automations WHERE kind='content_rain'")).rows[0]?.enabled).toBe(true);await tickSchool(db,config);expect((await db.query("SELECT enabled FROM automations WHERE kind='content_rain'")).rows[0]?.enabled).toBe(true);
});
it('concurrent rain ticks queue one bounded group reward and advance the schedule once',async()=>{
  await context(message('bot lluvia'),ctx=>configureRain(ctx,true,{schedule:{days:[1,2,3,4,5,6,7],time:'18:00'},count:2}));await db.query("UPDATE automations SET next_run_at=now()-interval '1 second' WHERE kind='content_rain'");
  await Promise.all([tickRain(db,config),tickRain(db,config)]);expect((await db.query("SELECT * FROM pack_orders WHERE kind='rain'")).rowCount).toBe(1);expect((await db.query("SELECT * FROM outbox WHERE kind='library_item' AND chat_id=$1",[config.LAB_CHAT_ID])).rowCount).toBe(2);
});
it('rain missed during outage is skipped and a missing catalog does not loop forever',async()=>{
  await context(message('bot lluvia'),ctx=>configureRain(ctx,true,{schedule:{days:[1],time:'18:00'},count:2}));await db.query("UPDATE automations SET next_run_at=now()-interval '3 days'");await tickRain(db,config);expect((await db.query('SELECT * FROM pack_orders')).rowCount).toBe(0);expect((await db.query('SELECT next_run_at>now() future FROM automations')).rows[0]?.future).toBe(true);
  await db.query('UPDATE library_items SET enabled=false');await db.query("UPDATE automations SET next_run_at=now()-interval '1 second'");await tickRain(db,config);expect((await db.query('SELECT next_run_at>now() future FROM automations')).rows[0]?.future).toBe(true);expect((await db.query("SELECT * FROM error_log WHERE where_='library.rain'")).rowCount).toBe(1);
});
it('rain rate limit survives schedule reconfiguration and cannot exceed one run per hour',async()=>{
  await command('bot lluvia 18:00 lunes,viernes 2');await db.query("UPDATE automations SET next_run_at=now()-interval '1 second'");await tickRain(db,config);await db.query("UPDATE pack_orders SET status='confirmed'");await command('bot lluvia 19:00 lunes 3');await db.query("UPDATE automations SET next_run_at=now()-interval '1 second'");await tickRain(db,config);expect((await db.query("SELECT * FROM pack_orders WHERE kind='rain'")).rowCount).toBe(1);
});
it('disabling rain cancels queued files permanently even if reenabled before sending',async()=>{
  await command('bot lluvia 18:00 lunes 2');await db.query("UPDATE automations SET next_run_at=now()-interval '1 second'");await tickRain(db,config);await command('bot lluvia off');await command('bot lluvia 19:00 lunes 2');
  let files=0;for(let i=0;i<10;i++){await db.query('UPDATE outbox SET sending_at=NULL');if(!await sendNext(db,{state:async()=>true,send:async d=>{if(d.media)files++;return {status:'sent',id:`test-${i}`};},reconcile:async()=>({status:'unknown'})},config))break;}expect(files).toBe(0);
});
it('replaying an administrative cancellation cannot cancel a newly opened activity',async()=>{
  await open();await add(100);const m=message('bot cooperacha cancelar');await context(m,cancelCooperacha);await open();await context(m,cancelCooperacha);expect((await co()).status).toBe('open');
});
it('a private pack purchase and a group contribution cannot spend the same global XP',async()=>{
  const { purchase }=await import('../src/modules/packs/orders.js');await open();await db.query('UPDATE wallets SET balance=500 WHERE user_id=$1',[owner]);
  const result=await Promise.allSettled([add(400,owner),context(message('bot pack',owner,owner),ctx=>purchase(ctx))]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance(owner)).toBeGreaterThanOrEqual(0);
  const spent=(await db.query<{n:number}>("SELECT -sum(delta)::int n FROM xp_ledger WHERE user_id=$1 AND reason IN ('pack_reserve','cooperacha_reserve')",[owner])).rows[0]!.n;expect(await balance(owner)+spent).toBe(500);
});
it('a stale cooperative snapshot cannot refund funds that already completed the goal',async()=>{
  const { closeCooperacha }=await import('../src/modules/packs/cooperacha.js');await open(50);const snapshot=await co();await add(50);await transaction(db,c=>closeCooperacha(c,snapshot,'cancelled'));
  expect((await co()).status).toBe('completed');expect(await balance()).toBe(950);expect(await balance('system:community')).toBe(50);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='cooperacha_refund'")).rowCount).toBe(0);
});
