import { spawn,type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { transaction } from '../src/db/client.js';
import { moveXp } from '../src/modules/xp/service.js';
import { purchase } from '../src/modules/packs/orders.js';
import { openCooperacha,contribute } from '../src/modules/packs/cooperacha.js';
import { db,config,owner,message,context,initialize,resetSchool } from './school-harness.js';
import { seedLibrary } from './library-harness.js';
beforeAll(initialize);beforeEach(async()=>{
  await resetSchool();await db.query('TRUNCATE wallets CASCADE');await seedLibrary();
  await db.query('CREATE TABLE IF NOT EXISTS library_mock_deliveries(id text PRIMARY KEY,count int NOT NULL)');await db.query('CREATE TABLE IF NOT EXISTS library_mock_control(pause boolean)');
  await db.query('TRUNCATE library_mock_deliveries,library_mock_control');await db.query('INSERT INTO library_mock_control VALUES(true)');
  await writeFile('.local/library-runtime-test.json',JSON.stringify({DATABASE_URL:config.DATABASE_URL,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:owner,BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:config.LAB_CHAT_ID,TRANSPORT:'mock'}),{mode:0o600});
  await transaction(db,c=>moveXp(c,owner,1000,'seed','restart',config.LAB_CHAT_ID));
});afterAll(async()=>{await db.query('DROP TABLE IF EXISTS library_mock_deliveries,library_mock_control');await db.end();});
async function start():Promise<ChildProcess>{
  const child=spawn(process.execPath,['--import','tsx','tests/library-runtime-child.ts'],{stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Startup timeout'));},10000);child.once('exit',()=>{clearTimeout(timer);reject(new Error('Startup failed'));});child.stdout?.on('data',(data:Buffer)=>{if(data.toString().includes('READY ')){clearTimeout(timer);resolve(child);}});});
}
async function stop(child:ChildProcess){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
async function until(check:()=>Promise<boolean>){const end=Date.now()+18000;while(Date.now()<end){if(await check())return;await delay(100);}throw new Error('Durable state timeout');}
it('SIGKILL after provider receipt reconciles a pack once and resumes only the remaining private files',async()=>{
  await context(message('bot pack'),ctx=>purchase(ctx));let child:ChildProcess|undefined;
  try{
    child=await start();await until(async()=>(await db.query('SELECT * FROM library_mock_deliveries')).rowCount===1);await stop(child);child=undefined;
    expect((await db.query("SELECT * FROM outbox WHERE kind='library_item' AND status='sending'")).rowCount).toBe(1);
    await db.query('UPDATE library_mock_control SET pause=false');child=await start();await until(async()=>(await db.query("SELECT * FROM pack_orders WHERE status='confirmed'")).rowCount===1);
    expect((await db.query('SELECT * FROM library_mock_deliveries WHERE count<>1')).rowCount).toBe(0);expect((await db.query("SELECT * FROM outbox WHERE kind='library_item' AND chat_id<>$1",[owner])).rowCount).toBe(0);
    expect((await db.query("SELECT * FROM xp_ledger WHERE reason='pack_reserve'")).rowCount).toBe(1);expect((await db.query("SELECT balance FROM wallets WHERE user_id=$1",[owner])).rows[0]?.balance).toBe(850);
  }finally{if(child)await stop(child);}
},35000);
it('a reserved cooperative survives SIGKILL and refunds expiry exactly once after restart',async()=>{
  await context(message('bot cooperacha'),ctx=>openCooperacha(ctx));await context(message('bot aporto'),ctx=>contribute(ctx,101));await db.query('UPDATE library_mock_control SET pause=false');let child:ChildProcess|undefined;
  try{
    child=await start();await stop(child);child=undefined;await db.query("UPDATE cooperachas SET expires_at=now()-interval '1 second'");child=await start();await until(async()=>(await db.query("SELECT * FROM cooperachas WHERE status='expired'")).rowCount===1);
    expect((await db.query("SELECT balance FROM wallets WHERE user_id=$1",[owner])).rows[0]?.balance).toBe(979);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='cooperacha_refund'")).rowCount).toBe(1);
    await stop(child);child=await start();await delay(300);expect((await db.query("SELECT * FROM xp_ledger WHERE reason='cooperacha_refund'")).rowCount).toBe(1);
  }finally{if(child)await stop(child);}
},30000);
