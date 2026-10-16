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
