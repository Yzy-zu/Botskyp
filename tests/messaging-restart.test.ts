import { spawn,type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { manageOperation } from '../src/modules/messaging/controls.js';
import { enqueueDrive } from '../src/modules/drive/service.js';
import { recoverDrive,claimDrive } from '../src/modules/drive/worker.js';
import { receive } from '../src/core/inbox.js';
import { db,config,owner,initialize,resetSchool,command,message,context } from './school-harness.js';
beforeAll(initialize);beforeEach(async()=>{
  await db.query('TRUNCATE bulk_ops CASCADE');await resetSchool();
  await db.query('CREATE TABLE IF NOT EXISTS messaging_mock_deliveries(id text PRIMARY KEY,count int NOT NULL)');await db.query('CREATE TABLE IF NOT EXISTS messaging_mock_control(pause boolean)');
  await db.query('TRUNCATE messaging_mock_deliveries,messaging_mock_control');await db.query('INSERT INTO messaging_mock_control VALUES(true)');
});afterAll(async()=>{await db.query('DROP TABLE messaging_mock_deliveries,messaging_mock_control');await db.query('TRUNCATE bulk_ops CASCADE');await db.end();});
async function start(mode='bulk'):Promise<ChildProcess>{
  await writeFile('.local/messaging-runtime-test.json',JSON.stringify({mode,env:{DATABASE_URL:config.DATABASE_URL,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:owner,BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:config.LAB_CHAT_ID,TRANSPORT:'mock',DRIVE_ENABLED:'true'}}),{mode:0o600});
  const child=spawn(process.execPath,['--import','tsx','tests/messaging-runtime-child.ts'],{stdio:['ignore','pipe','pipe']});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Startup timeout'));},10000);child.once('exit',()=>{clearTimeout(timer);reject(new Error('Child exited'));});child.stdout?.on('data',(data:Buffer)=>{if(data.toString().includes('READY')){clearTimeout(timer);resolve(child);}});});
}
async function kill(child:ChildProcess){const end=once(child,'exit');child.kill('SIGKILL');await end;}
async function until(check:()=>Promise<boolean>){const end=Date.now()+20000;while(Date.now()<end){if(await check())return;await delay(100);}throw new Error('Persistent state timeout');}
it('SIGKILL after a provider receipt reconciles once and resumes only remaining Nuclear messages',async()=>{
  await command('bot nuclear 5 | Prueba de reinicio');await command('sí');await db.query("DELETE FROM outbox WHERE kind='text'");
  const op=(await db.query<{id:string}>('SELECT id FROM bulk_ops')).rows[0]!;let child:ChildProcess|undefined;
  try{
    child=await start();await until(async()=>(await db.query('SELECT * FROM messaging_mock_deliveries')).rowCount===1);await kill(child);child=undefined;
    expect((await db.query("SELECT * FROM outbox WHERE kind='bulk_text' AND status='sending'")).rowCount).toBe(1);
    await db.query('UPDATE messaging_mock_control SET pause=false');child=await start();
    await until(async()=>(await db.query("SELECT * FROM outbox WHERE kind='bulk_text' AND status='sent'")).rowCount===1);
    await context(message('continue'),ctx=>manageOperation(ctx,op.id,'resume'));
    await until(async()=>(await db.query("SELECT * FROM bulk_ops WHERE status='done'")).rowCount===1);
    expect((await db.query('SELECT * FROM messaging_mock_deliveries WHERE count<>1')).rowCount).toBe(0);
    expect((await db.query('SELECT * FROM messaging_mock_deliveries')).rowCount).toBe(5);
    const intervals=(await db.query<{gap:string}>(`SELECT extract(epoch FROM sending_at-lag(sending_at) OVER(ORDER BY id))*1000 gap FROM outbox WHERE kind='bulk_text'`)).rows.filter(r=>r.gap!==null);
    expect(intervals.every(r=>Number(r.gap)>=1500)).toBe(true);
    expect((await db.query("SELECT * FROM outbox WHERE kind='bulk_text' AND chat_id<>$1",[config.LAB_CHAT_ID])).rowCount).toBe(0);
  }finally{if(child)await kill(child);}
},40000);
it('SIGKILL during Drive creation retains the preallocated remote ID for review without replay',async()=>{
  const enabled={...config,DRIVE_ENABLED:true};await db.query("UPDATE chats SET settings='{\"drive\":true}'");
  const msg=message('bot drive subir');msg.attachments=[{kind:'document',ref:`${msg.id}:document`,mime:'text/plain'}];await receive(db,enabled,msg);await context(msg,ctx=>enqueueDrive(ctx,'upload'),{config:enabled});let child:ChildProcess|undefined;
  try{
    child=await start('drive');await until(async()=>(await db.query('SELECT * FROM messaging_mock_deliveries')).rowCount===1);await kill(child);child=undefined;
    await recoverDrive(db);expect(await claimDrive(db)).toBeUndefined();
    expect((await db.query('SELECT phase,remote_id FROM drive_operations')).rows[0]).toMatchObject({phase:'review',remote_id:'remote_uploaded_123'});
    expect((await db.query('SELECT count FROM messaging_mock_deliveries')).rows[0]?.count).toBe(1);
    expect((await db.query("SELECT * FROM outbox WHERE kind='drive_link'")).rowCount).toBe(0);
  }finally{if(child)await kill(child);}
},30000);
