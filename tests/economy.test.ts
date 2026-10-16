import { beforeAll,beforeEach,afterAll,expect,it } from 'vitest';
import { transaction } from '../src/db/client.js';
import { activity,daily,dailyReward,level,moveXp,wallet } from '../src/modules/xp/service.js';
import { receive,processNext } from '../src/core/inbox.js';
import { db,config,owner,admin,member,message,initialize,resetSchool,context,command,execute } from './school-harness.js';
beforeAll(initialize);beforeEach(async()=>{await resetSchool();await db.query('TRUNCATE wallets CASCADE');});afterAll(()=>db.end());
const move=(user:string,delta:number,ref:string)=>transaction(db,c=>moveXp(c,user,delta,'test',ref,config.LAB_CHAT_ID));
const balance=async(user=owner)=>(await db.query<{balance:number}>('SELECT balance FROM wallets WHERE user_id=$1',[user])).rows[0]?.balance;
it('serializes concurrent credits and keeps ledger equal to wallet',async()=>{
  await Promise.all(Array.from({length:30},(_,i)=>move(owner,1,String(i))));
  expect(await balance()).toBe(30);expect((await db.query('SELECT sum(delta)::int AS n FROM xp_ledger')).rows[0]?.n).toBe(30);
});
it('gives one credit for thirty concurrent identical references',async()=>{
  const results=await Promise.all(Array.from({length:30},()=>move(owner,500,'same')));
  expect(results.filter(Boolean)).toHaveLength(1);expect(await balance()).toBe(500);
});
it('only one of two concurrent spends can consume the balance',async()=>{
  await move(owner,50,'seed');const results=await Promise.allSettled([move(owner,-40,'a'),move(owner,-40,'b')]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance()).toBe(10);
  expect((await db.query('SELECT count(*)::int AS n FROM xp_ledger')).rows[0]?.n).toBe(2);
});
it('rolls back ledger and wallet together after a crash before commit',async()=>{
  await expect(transaction(db,async c=>{await moveXp(c,owner,100,'test','rollback',config.LAB_CHAT_ID);throw new Error('crash');})).rejects.toThrow('crash');
  expect(await balance()).toBeUndefined();expect((await db.query('SELECT * FROM xp_ledger')).rowCount).toBe(0);
  await move(owner,100,'rollback');expect(await balance()).toBe(100);
});
it('database constraint forbids negative balances even outside service',async()=>{
  await move(owner,20,'seed');await expect(db.query('UPDATE wallets SET balance=-1 WHERE user_id=$1',[owner])).rejects.toThrow();expect(await balance()).toBe(20);
});
it('duplicate debit never spends twice and losses reduce level',async()=>{
  await move(owner,100,'seed');expect(level((await balance())!)).toBe(6);
  await move(owner,-41,'spend');await move(owner,-41,'spend');expect(await balance()).toBe(59);expect(level(59)).toBe(3);
  await move(owner,-59,'loss');expect(level((await balance())!)).toBe(1);
});
it.each([[0,1000],[2,1000],[3,300],[14,300],[15,100],[49,100],[50,40],[84,40],[85,15],[94,15],[95,0],[99,0]])('daily roll %i awards %i', (roll,xp)=>{expect(dailyReward(roll,1)).toBe(xp);});
it('streak bonus caps at 100 and never adds to zero',()=>{expect(dailyReward(0,9)).toBe(1100);expect(dailyReward(95,9)).toBe(0);});
it('daily retry uses original result without another random roll',async()=>{
  let rolls=0;const now=new Date();const claim=()=>transaction(db,c=>daily(c,owner,config.LAB_CHAT_ID,'same',now,()=>{rolls++;return 0;}));
  await claim();await claim();expect(rolls).toBe(1);expect(await balance()).toBe(1000);
});
it('concurrent daily claims across chats share a single 24-hour wallet cooldown',async()=>{
  const now=new Date();const results=await Promise.allSettled(['300@g.us','400@g.us'].map(chat=>transaction(db,c=>daily(c,owner,chat,chat,now,()=>50))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await balance()).toBe(40);
});
it('daily exactly at 24h continues streak, over 48h resets it',async()=>{
  const now=new Date();const claim=(ref:string,when:Date)=>transaction(db,c=>daily(c,owner,config.LAB_CHAT_ID,ref,when,()=>50));
  await claim('1',now);await claim('2',new Date(+now+86400000));expect(await balance()).toBe(100);
  expect((await db.query('SELECT streak FROM wallets')).rows[0]?.streak).toBe(2);
  await claim('3',new Date(+now+86400000+172800001));expect(await balance()).toBe(140);expect((await db.query('SELECT streak FROM wallets')).rows[0]?.streak).toBe(1);
});
it('zero daily still consumes claim and advances streak',async()=>{
  await transaction(db,c=>daily(c,owner,config.LAB_CHAT_ID,'zero',new Date(),()=>99));
  expect(await balance()).toBe(0);expect((await db.query('SELECT streak FROM wallets')).rows[0]?.streak).toBe(1);
  await expect(transaction(db,c=>daily(c,owner,config.LAB_CHAT_ID,'another',new Date(),()=>0))).rejects.toThrow('24 horas');
});
it('ordinary unaddressed activity earns XP once per minute without replying',async()=>{
  expect(await command('hola grupo',member)).toBeUndefined();expect(await balance(member)).toBe(1);
  await command('otro mensaje',member);expect(await balance(member)).toBe(1);
});
it('activity ignores short text, bots, strangers, private chats and disabled modules',async()=>{
  await command('hi',member);await command('mensaje desconocido','700@s.whatsapp.net');
  const msg=message('hola grupo',member);msg.fromMe=true;await receive(db,config,msg);await processNext(db,config);
  await command(message('hola grupo',owner,owner));
  await db.query("UPDATE chats SET settings='{\"modules\":{\"xp\":false}}' WHERE id=$1",[config.LAB_CHAT_ID]);await command('hola grupo',member);
  expect((await db.query('SELECT * FROM xp_ledger')).rowCount).toBe(0);
});
it('activity cooldown is per chat but wallet is global',async()=>{
  const first=message('hola',member);const second=message('hola',member,'400@g.us');
  await db.query("UPDATE chats SET settings='{\"modules\":{\"xp\":true}}' WHERE id='400@g.us'");
  await db.query("INSERT INTO group_memberships(chat_id,user_id) VALUES('400@g.us',$1)",[member]);
  for(const m of [first,second])await context(m,ctx=>activity(ctx));expect(await balance(member)).toBe(2);
});
it('duplicate webhook does not award twice',async()=>{
  const m=message('hola',member);expect(await receive(db,config,m)).toBe('accepted');expect(await receive(db,config,m)).toBe('duplicate');await processNext(db,config);expect(await balance(member)).toBe(1);
});
it('activity at exactly one minute is eligible again',async()=>{
  const m=message('hola',member);await context(m,ctx=>activity(ctx));
  await context({...m,id:'next',ts:new Date(+m.ts+60000)},ctx=>activity(ctx));expect(await balance(member)).toBe(2);
});
it('happy hour is manual, group administrative and expires',async()=>{
  expect((await execute('xp.happy',{},member)).ok).toBe(false);expect((await execute('xp.happy',{},admin)).ok).toBe(true);
  await command('hola',member);expect(await balance(member)).toBe(20);
  await db.query("UPDATE chats SET settings=jsonb_set(settings,'{happy_hour_until}',to_jsonb((now()-interval '1 second')::text))");
  await db.query("UPDATE activity_marks SET last_at=last_at-interval '2 minutes'");
  await command('hola otra vez',member);expect(await balance(member)).toBe(21);
});
it('xp and administrative commands work without Gemini and do not accept injected identity',async()=>{
  expect(await command('bot xp')).toContain('Nivel:');expect(await command('bot diario')).toContain('Diario registrado');
  expect((await execute('xp.daily',{actor:member})).ok).toBe(false);
});
it('maintenance and emergency suppress passive XP',async()=>{
  await command('bot mantenimiento on');await command('texto grupal',member);
  await command('bot apagado de emergencia');await command('texto nuevo',member);
  expect(await balance(member) ?? 0).toBe(0);
});
it('wallet read starts at zero without fabricated historical XP',async()=>{expect(await transaction(db,c=>wallet(c,owner))).toMatchObject({balance:0,streak:0});});
