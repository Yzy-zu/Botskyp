import { spawn,type ChildProcess } from 'node:child_process';
import { readFileSync,writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { it,expect } from 'vitest';
import { createDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
async function start():Promise<{child:ChildProcess;address:string}>{
  const child=spawn(process.execPath,['--import','tsx','tests/runtime-child.ts'],{stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Child did not start'));},10000);
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Child exited before ready'));});
    child.stdout?.on('data',(data:Buffer)=>{
      const match=/READY (http:\/\/[^\s]+)/.exec(data.toString());
      if(match?.[1]){clearTimeout(timeout);resolve({child,address:match[1]});}
    });
  });
}
async function until(predicate:()=>Promise<boolean>,ms=20000):Promise<void>{
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){if(await predicate())return;await delay(100);}
  throw new Error('Timed out waiting for durable state');
}
it('SIGKILL during a real HTTP burst recovers inbox and uncertain delivery exactly once',async()=>{
  if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
  const db=createDb(url);let child:ChildProcess|undefined;
  try{
    await migrate(db);
    await db.query('TRUNCATE inbox,seen_events,outbox,chats,group_memberships,system_flags CASCADE');
    await db.query('CREATE TABLE mock_deliveries(id text PRIMARY KEY,count int NOT NULL)');
    await db.query('CREATE TABLE mock_control(pause boolean)');await db.query('INSERT INTO mock_control VALUES(true)');
    await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
    writeFileSync('.local/runtime-test.json',JSON.stringify({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'}),{mode:0o600});
    const first=await start();child=first.child;
    const inputs=Array.from({length:12},(_,i)=>({id:`crash-${i}`,chatId:'300@g.us',senderId:'100@s.whatsapp.net',isGroup:true,ts:new Date().toISOString(),text:'bot ping',fromMe:false,mentions:[],attachments:[]}));
    for(const body of inputs){
      const r=await fetch(`${first.address}/webhook`,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':'x'.repeat(32)},body:JSON.stringify(body)});expect(r.status).toBe(200);
    }
    await until(async()=>(await db.query('SELECT * FROM mock_deliveries')).rowCount===1);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    expect((await db.query("SELECT * FROM outbox WHERE status='sending'")).rowCount).toBe(1);
    await db.query('UPDATE mock_control SET pause=false');
    const second=await start();child=second.child;
    for(const body of inputs){
      const r=await fetch(`${second.address}/webhook`,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':'x'.repeat(32)},body:JSON.stringify(body)});
      expect((await r.json() as {status:string}).status).toBe('duplicate');
    }
    await until(async()=>(await db.query("SELECT * FROM outbox WHERE status='sent'")).rowCount===12);
    expect((await db.query('SELECT * FROM mock_deliveries')).rowCount).toBe(12);
    expect((await db.query('SELECT * FROM mock_deliveries WHERE count<>1')).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM inbox WHERE status<>'done'")).rowCount).toBe(0);
  } finally {if(child){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await db.end();}
},35000);
it('a reminder survives SIGKILL before its deadline and is delivered once within 30 seconds',async()=>{
  if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
  const db=createDb(url);let child:ChildProcess|undefined;
  try{
    await migrate(db);
    await db.query('TRUNCATE inbox,seen_events,outbox,chats,group_memberships,system_flags,reminders,sessions CASCADE');
    await db.query('CREATE TABLE IF NOT EXISTS mock_deliveries(id text PRIMARY KEY,count int NOT NULL)');
    await db.query('CREATE TABLE IF NOT EXISTS mock_control(pause boolean)');
    await db.query('TRUNCATE mock_deliveries,mock_control');await db.query('INSERT INTO mock_control VALUES(false)');
    await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
    const due=new Date(Date.now()+4_000);
    await db.query("INSERT INTO reminders(chat_id,owner_id,body,due_at,timezone) VALUES('300@g.us','100@s.whatsapp.net','reinicio real de proceso',$1,'America/Mexico_City')",[due]);
    writeFileSync('.local/runtime-test.json',JSON.stringify({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'}),{mode:0o600});
    child=(await start()).child;
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
    await delay(Math.max(0,due.getTime()-Date.now()+200));
    child=(await start()).child;
    await until(async()=>(await db.query("SELECT * FROM reminders WHERE status='sent'")).rowCount===1,15_000);
    const rows=await db.query<{sent_at:Date}>("SELECT sent_at FROM outbox WHERE dedupe_key LIKE 'reminder:%'");
    expect(rows.rowCount).toBe(1);expect(Math.abs(rows.rows[0]!.sent_at.getTime()-due.getTime())).toBeLessThanOrEqual(30_000);
    expect((await db.query('SELECT * FROM mock_deliveries WHERE count<>1')).rowCount).toBe(0);
  }finally{if(child){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await db.end();}
},30_000);
it('a school summary survives process death and sends one catch-up after several missed days',async()=>{
  if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
  const db=createDb(url);let child:ChildProcess|undefined;
  try{
    await migrate(db);
    await db.query('TRUNCATE inbox,seen_events,outbox,chats,group_memberships,system_flags,reminders,sessions CASCADE');
    await db.query('CREATE TABLE IF NOT EXISTS mock_deliveries(id text PRIMARY KEY,count int NOT NULL)');
    await db.query('CREATE TABLE IF NOT EXISTS mock_control(pause boolean)');
    await db.query('TRUNCATE mock_deliveries,mock_control');await db.query('INSERT INTO mock_control VALUES(false)');
    await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
    await db.query("INSERT INTO school_config(chat_id,target_group_id,summary_schedule) VALUES('300@g.us','300@g.us','{\"days\":[1,2,3,4,5,6,7],\"time\":\"07:00\"}')");
    await db.query("INSERT INTO automations(chat_id,kind,owner_id,enabled,config,next_run_at) VALUES('300@g.us','school_summary','100@s.whatsapp.net',true,'{\"days\":[1,2,3,4,5,6,7],\"time\":\"07:00\"}',now()+interval '1 day')");
    writeFileSync('.local/runtime-test.json',JSON.stringify({DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'}),{mode:0o600});
    child=(await start()).child;
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
    await db.query("UPDATE automations SET next_run_at=now()-interval '3 days'");
    child=(await start()).child;
    await until(async()=>(await db.query("SELECT * FROM outbox WHERE kind='school_summary' AND status='sent'")).rowCount===1,15_000);
    await until(async()=>(await db.query('SELECT * FROM automations WHERE outbox_id IS NULL AND next_run_at>now()')).rowCount===1,15_000);
    expect((await db.query('SELECT * FROM mock_deliveries')).rowCount).toBe(1);
    expect((await db.query('SELECT * FROM mock_deliveries WHERE count<>1')).rowCount).toBe(0);
    expect((await db.query<{payload:{text:string}}>("SELECT payload FROM outbox WHERE kind='school_summary'")).rows[0]?.payload.text).toContain('retraso');
  }finally{if(child){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await db.end();}
},30_000);

it('blackjack preserves its exact deck, hands and deadline through SIGKILL and pays once after timeout',async()=>{
  const { readConfig }=await import('../src/config.js');
  const { transaction }=await import('../src/db/client.js');
  const { moveXp }=await import('../src/modules/xp/service.js');
  const { gameCommand }=await import('../src/modules/games/service.js');
  const db=createDb(url);let child:ChildProcess|undefined;
  try{
    await migrate(db);
    await db.query('TRUNCATE inbox,seen_events,outbox,chats,group_memberships,system_flags,reminders,sessions,wallets CASCADE');
    await db.query('CREATE TABLE IF NOT EXISTS mock_deliveries(id text PRIMARY KEY,count int NOT NULL)');
    await db.query('CREATE TABLE IF NOT EXISTS mock_control(pause boolean)');
    await db.query('TRUNCATE mock_deliveries,mock_control');await db.query('INSERT INTO mock_control VALUES(false)');
    await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true)");
    const input={DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'};
    const config=readConfig({GEMINI_API_KEY:'fixture-gemini-key',...input});writeFileSync('.local/runtime-test.json',JSON.stringify(input),{mode:0o600});
    await transaction(db,async c=>{
      await moveXp(c,'100@s.whatsapp.net',200,'seed','restart','300@g.us');
      await gameCommand({c,db,config,actor:{id:'100@s.whatsapp.net',role:'owner'},chat:{id:'300@g.us',isGroup:true,enabled:true,settings:{}},msg:{id:'game-before-crash',chatId:'300@g.us',senderId:'100@s.whatsapp.net',isGroup:true,ts:new Date(),text:'bot blackjack',fromMe:false,mentions:[],attachments:[]},now:new Date(),search:async()=>''},{action:'solo'},max=>max-1);
    });
    const original=(await db.query('SELECT id,state,expires_at,version,status FROM games')).rows[0];expect(original?.status).toBe('playing');
    child=(await start()).child;
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
    child=(await start()).child;
    expect((await db.query('SELECT id,state,expires_at,version,status FROM games')).rows[0]).toEqual(original);
    await db.query("UPDATE games SET expires_at=clock_timestamp()-interval '1 second'");
    await until(async()=>(await db.query("SELECT * FROM games WHERE status='done'")).rowCount===1,12000);
    expect((await db.query("SELECT * FROM xp_ledger WHERE reason='bet'")).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM xp_ledger WHERE reason='payout'")).rowCount).toBe(1);
    expect((await db.query('SELECT balance FROM wallets')).rows[0]?.balance).toBe(200);
    const exitedAgain=once(child,'exit');child.kill('SIGKILL');await exitedAgain;child=undefined;
    child=(await start()).child;
    await until(async()=>(await db.query("SELECT * FROM outbox WHERE status='sent'")).rowCount===1,12000);
    expect((await db.query("SELECT * FROM xp_ledger WHERE reason='payout'")).rowCount).toBe(1);
    expect((await db.query('SELECT * FROM mock_deliveries WHERE count<>1')).rowCount).toBe(0);
  }finally{if(child){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await db.end();}
},35000);
