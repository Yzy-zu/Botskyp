import { fork } from 'node:child_process';
import { once } from 'node:events';
import { beforeAll,beforeEach,afterAll,it,expect } from 'vitest';
import { createDb,transaction } from '../src/db/client.js';
import { observeConnection,checkConnection } from '../src/wa/connection.js';
import { MockEvolution } from '../src/wa/mock.js';
import { cleanupEphemeral } from '../src/core/cleanup.js';
import { db,config,initialize,resetSchool,command } from './school-harness.js';
import { product } from '../config/product.js';
const real={...config,TRANSPORT:'evolution' as const};
const since=new Date('2026-10-17T00:00:00Z');
const later=new Date('2026-10-17T00:17:00Z');
beforeAll(initialize);beforeEach(async()=>{await resetSchool();await db.query('TRUNCATE jobs CASCADE');});afterAll(()=>db.end());
const notices=async()=> (await db.query<{chat_id:string;payload:{text:string};dedupe_key:string}>("SELECT * FROM outbox WHERE dedupe_key LIKE 'alert:evolution-recovered:%'")).rows;
it('never announces recovery without a confirmed prior failure',async()=>{await observeConnection(db,real,true);await observeConnection(db,real,true);expect(await notices()).toHaveLength(0);});
it('persists the initial outage across repeated failures then queues exactly one owner notice',async()=>{
  await observeConnection(db,real,false,since);await observeConnection(db,real,false,later);expect((await db.query("SELECT value FROM system_flags WHERE key='evolution_outage'")).rows[0]?.value.downSince).toBe(since.toISOString());
  await observeConnection(db,real,true,later);for(let i=0;i<5;i++)await observeConnection(db,real,true,later);const rows=await notices();expect(rows).toHaveLength(1);expect(rows[0]?.chat_id).toBe(config.OWNER_JIDS[0]);expect(rows[0]?.payload.text).toContain('17 minuto(s)');
});
it('restart during an outage and after recovery cannot duplicate the notice',async()=>{
  await observeConnection(db,real,false,since);const fresh=createDb(config.DATABASE_URL);
  try{await observeConnection(fresh,real,false,later);await observeConnection(fresh,real,true,later);}finally{await fresh.end();}
  const restarted=createDb(config.DATABASE_URL);try{await observeConnection(restarted,real,true,later);}finally{await restarted.end();}expect(await notices()).toHaveLength(1);
});
it('concurrent healthchecks serialize the transition',async()=>{await observeConnection(db,real,false,since);await Promise.all(Array.from({length:8},()=>observeConnection(db,real,true,later)));expect(await notices()).toHaveLength(1);});
it('different real outages receive one distinct notice each',async()=>{for(let i=0;i<2;i++){await observeConnection(db,real,false,since);await observeConnection(db,real,true,later);}expect(await notices()).toHaveLength(2);});
it('unavailable provider exceptions count as a confirmed observed outage',async()=>{const t=new MockEvolution();t.state=async()=>{throw new Error('offline');};expect(await checkConnection(db,real,t)).toBe(false);t.state=async()=>true;expect(await checkConnection(db,real,t)).toBe(true);expect(await notices()).toHaveLength(1);});
it('mock health never alters production connection flags',async()=>{await observeConnection(db,config,false,since);await observeConnection(db,config,true,later);expect(await notices()).toHaveLength(0);});
it('recovery insertion and outage reset roll back together on persistence failure',async()=>{
  await observeConnection(db,real,false,since);
  await db.query("CREATE FUNCTION reject_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$");await db.query('CREATE TRIGGER reject_recovery BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_recovery()');
  try{await expect(observeConnection(db,real,true,later)).rejects.toThrow();expect((await db.query("SELECT * FROM system_flags WHERE key='evolution_outage'")).rowCount).toBe(1);}finally{await db.query('DROP TRIGGER reject_recovery ON outbox');await db.query('DROP FUNCTION reject_recovery()');}
  await observeConnection(db,real,true,later);expect(await notices()).toHaveLength(1);
});
const clean=()=>transaction(db,cleanupEphemeral);
it('cleanup removes only old completed input, orphan dedupe, quota and context',async()=>{
  await command('bot ping');await db.query("UPDATE inbox SET received_at=now()-interval '31 days'");await db.query("UPDATE seen_events SET seen_at=now()-interval '31 days'");
  await db.query("INSERT INTO llm_usage(actor_id,model,purpose,at) VALUES('test','test','test',now()-interval '31 days'),('test','test','test',now())");
  await clean();expect((await db.query('SELECT * FROM inbox')).rowCount).toBe(0);expect((await db.query('SELECT * FROM seen_events')).rowCount).toBe(0);expect((await db.query('SELECT * FROM llm_usage')).rowCount).toBe(1);expect((await db.query('SELECT * FROM outbox')).rowCount).toBe(1);
});
it('cleanup preserves recent, queued and failed input with dedupe references',async()=>{
  for(const [id,status,days] of [['recent','done',1],['pending','queued',31],['failed','failed',31]] as const){await db.query('INSERT INTO seen_events(provider_msg_id,seen_at) VALUES($1,now()-$2::int*interval \'1 day\')',[id,days]);await db.query('INSERT INTO inbox(provider_msg_id,chat_id,payload,status,received_at) VALUES($1,\'300@g.us\',\'{}\',$2,now()-$3::int*interval \'1 day\')',[id,status,days]);}
  await clean();expect((await db.query('SELECT * FROM inbox')).rowCount).toBe(3);expect((await db.query('SELECT * FROM seen_events')).rowCount).toBe(3);
});
it('cleanup never deletes persistent user data or economic/audit evidence',async()=>{
  await command('bot nota guarda Persistente');await command('bot recordatorio en 2 minutos Pendiente');await db.query("UPDATE notes SET created_at=now()-interval '90 days'");
  const tables=['xp_ledger','wallets','audit_log','notes','reminders','users','chats','outbox','school_subjects','school_tasks','pack_orders'];const before=[];
  for(const table of tables)before.push((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number);
  await clean();for(const [i,table] of tables.entries())expect((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.n,table).toBe(before[i]);
});
it('cleanup is throttled and bounded to one configured batch',async()=>{
  await db.query("INSERT INTO seen_events(provider_msg_id,seen_at) SELECT 'batch-'||i,now()-interval '31 days' FROM generate_series(1,$1) i",[product.cleanupBatch+2]);await clean();expect((await db.query('SELECT * FROM seen_events')).rowCount).toBe(2);await clean();expect((await db.query('SELECT * FROM seen_events')).rowCount).toBe(2);
  await db.query("UPDATE system_flags SET updated_at=now()-interval '2 hours' WHERE key='cleanup_last_run'");await clean();expect((await db.query('SELECT * FROM seen_events')).rowCount).toBe(0);
});
it('cleanup retains input evidence needed by an active job',async()=>{
  await command('bot ping');await db.query("UPDATE inbox SET received_at=now()-interval '31 days'");await db.query("UPDATE seen_events SET seen_at=now()-interval '31 days'");await db.query("INSERT INTO jobs(kind,chat_id,payload) VALUES('test','300@g.us','{}')");await clean();expect((await db.query('SELECT * FROM inbox')).rowCount).toBe(1);expect((await db.query('SELECT * FROM seen_events')).rowCount).toBe(1);
});

it('SIGKILL during outage and after recovery preserves exactly one notice across real processes',async()=>{
  for(const open of [false,true,true]){
    const child=fork(new URL('./connection-runtime-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});
    try{
      const persisted=once(child,'message');child.send({url:config.DATABASE_URL,open});expect((await persisted)[0]).toBe('persisted');
    }finally{const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  }
  expect(await notices()).toHaveLength(1);
});
