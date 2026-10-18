import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,readdir,rm,utimes,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll,afterEach,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { Recorder } from '../src/observer/recorder.js';
import { redact } from '../src/observer/redact.js';
import { observer,startObserver } from '../src/observer/index.js';
import { insertEvents } from '../src/observer/postgres.js';
import { eventTypes,type ObserverEvent } from '../src/observer/types.js';
import { db,config,owner,member,chat,initialize,reset,context,backing,png } from './r4-harness.js';
import { receive,processNext } from '../src/core/inbox.js';
import { route } from '../src/core/router.js';
import type { Llm } from '../src/core/llm.js';
import { executeToolV2 } from '../src/core/policy-v2/executor.js';
import { registerArtifactV2 } from '../src/core/artifact-registration-v2.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import * as normalize from '../src/core/policy-v2/normalize.js';
import { transaction } from '../src/db/client.js';
import { claimMedia,processMedia,recoverMedia } from '../src/modules/media/worker.js';
import { sendNext } from '../src/wa/outbox.js';
import { MockEvolution } from '../src/wa/mock.js';
let root:string,stop:()=>Promise<void>;
const enabled={...config,OBSERVER_ENABLED:true,GEMINI_FREE_TIER_CONFIRMED:true};
async function flush(){await observer.flush();await observer.flush();}
async function events(turnId?:string):Promise<ObserverEvent[]>{await flush();return (await db.query<{e:ObserverEvent}>(`SELECT correlation||jsonb_build_object('payload',payload) e FROM observer_events ${turnId?'WHERE turn_id=$1':''} ORDER BY sequence,event_id`,turnId?[turnId]:[])).rows.map(r=>r.e);}
const say={text:'{"outcome":"conversation","text":"Respuesta exacta.","effects":[]}',calls:[],content:{role:'model',parts:[{text:'{"outcome":"conversation","text":"Respuesta exacta.","effects":[]}'}]}};
async function inbound(){const id=randomUUID();expect(await receive(db,enabled,{id,chatId:chat,senderId:owner,isGroup:true,ts:new Date(),text:'bot guarda literalmente hola',mentions:[],attachments:[],fromMe:false},new Date(),{event:'messages.upsert',message:'original',apikey:'fixture-gemini-key'})).toBe('accepted');return (await db.query<{turn_id:string}>('SELECT turn_id FROM inbox WHERE payload->>\'id\'=$1',[id])).rows[0]!.turn_id;}
beforeAll(async()=>{await initialize();root=await mkdtemp(join(tmpdir(),'botsky-observer-'));});
beforeEach(async()=>{await reset();await db.query('TRUNCATE observer_events');enabled.OBSERVER_SPOOL_DIR=join(root,randomUUID());stop=startObserver(enabled,'app');});
afterEach(async()=>{await stop();vi.restoreAllMocks();vi.unstubAllGlobals();});
afterAll(async()=>{await rm(root,{recursive:true,force:true});await db.end();});

it('A: records exact ingress, context, each Gemini call, capability, Policy, handler, commit and delivery in order',async()=>{
  let n=0;vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{role:'model',opaque:'retained',parts:[{thoughtSignature:'signature-kept',functionCall:++n===1?{name:'core_load_capability',args:{domain:'productivity',toolName:'notes.create'}}:{name:'notes_create',args:{body:'nota exacta'}}}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:3}}),{status:200})));
  const id=await inbound();expect(await processNext(db,enabled)).toBe(true);
  expect(await sendNext(db,new MockEvolution(),enabled)).toBe(true);
  const timeline=await events(id),types=timeline.map(e=>e.eventType);
  for(const type of ['INBOUND_ACCEPTED','INBOUND_NORMALIZED','TURN_STARTED','CONTEXT_BUILT','LLM_REQUEST','LLM_RESPONSE','CAPABILITY_LOAD','TOOL_PROPOSED','POLICY_EVALUATED','TOOL_STARTED','TOOL_RESULT','TRANSACTION_COMMIT','OUTBOX_QUEUED','OUTBOX_SENT','TURN_COMPLETED'])expect(types).toContain(type);
  expect(types.indexOf('LLM_REQUEST')).toBeLessThan(types.indexOf('POLICY_EVALUATED'));
  expect(timeline.map(e=>e.sequence)).toEqual([...timeline.map(e=>e.sequence)].sort());
  expect(new Set(timeline.map(e=>e.sequence)).size).toBe(timeline.length);
  const serialized=JSON.stringify(timeline);expect(serialized).toContain('signature-kept');expect(serialized).toContain('opaque');expect(serialized).not.toContain('fixture-gemini-key');
  expect((await db.query('SELECT * FROM observer_turns WHERE turn_id=$1',[id])).rows[0]).toMatchObject({llm_calls:'2',final_status:'sent',user_text:'bot guarda literalmente hola'});
});
it('B: Gemini timeout retains request, error, fallback and failed-stage evidence',async()=>{
  const llm:Llm={generate:async()=>{throw new DOMException('provider timeout','TimeoutError');}};
  const id=await context({text:'bot hola'},ctx=>observer.scope({turnId:ctx.turnId!},async()=>{expect(await route(ctx,llm)).toContain('IA no pudo');return ctx.turnId!;}));
  const types=(await events(id)).map(e=>e.eventType);expect(types).toEqual(expect.arrayContaining(['LLM_REQUEST','LLM_ERROR','TURN_FAILED']));
});
it('C: denied Policy records exact proposal and reason without running a handler',async()=>{
  const id=await context({text:'bot reinicia',senderId:member},ctx=>observer.scope({turnId:ctx.turnId!},async()=>{
    await executeToolV2(ctx,'minecraft.restart',{}, {callOrigin:'llm',safeRefMap:new SafeRefs([])});return ctx.turnId!;
  }));
  const timeline=await events(id);expect(timeline.some(e=>e.eventType==='POLICY_EVALUATED' && JSON.stringify(e.payload).includes('DENIED_PERMISSION'))).toBe(true);
  expect(timeline.some(e=>e.eventType==='TOOL_STARTED')).toBe(false);
});
it('D: handler exception rolls back its note but preserves started/error/savepoint evidence independently',async()=>{
  vi.spyOn(normalize,'normalizeLegacyResult').mockRejectedValueOnce(new Error('fixture handler failed'));
  const id=await context({text:'bot nota'},ctx=>observer.scope({turnId:ctx.turnId!},async()=>{
    const result=await executeToolV2(ctx,'notes.create',{body:'will roll back'},{callOrigin:'llm',safeRefMap:new SafeRefs([])});expect(result.status).toBe('error');return ctx.turnId!;
  }));
  expect((await db.query('SELECT * FROM notes')).rowCount).toBe(0);
  const types=(await events(id)).map(e=>e.eventType);expect(types).toEqual(expect.arrayContaining(['TOOL_STARTED','TOOL_ERROR','TRANSACTION_ROLLBACK']));
});
it('D2: full business rollback preserves observer events with an independent connection',async()=>{
  const turnId=randomUUID();await expect(observer.scope({turnId},()=>transaction(db,async c=>{
    observer.bindClient(c,{turnId});observer.emit({eventType:'TOOL_STARTED',stage:'test'});await c.query('INSERT INTO notes(chat_id,author_id,body) VALUES($1,$2,$3)',[chat,owner,'rollback']);throw new Error('rollback test');
  }))).rejects.toThrow('rollback test');
  expect((await db.query('SELECT * FROM notes')).rowCount).toBe(0);expect((await events(turnId)).map(e=>e.eventType)).toContain('TRANSACTION_ROLLBACK');
});
it('E: actual observer INSERT failure leaves durable spool while Botsky returns the same reply',async()=>{
  await flush();await db.query('ALTER TABLE observer_events RENAME TO observer_events_unavailable');
  try{
    await context({text:'bot hola'},ctx=>observer.scope({turnId:ctx.turnId!},async()=>{expect(await route(ctx,{generate:async()=>say})).toBe('Respuesta exacta.');}));
    await flush();const files=await readdir(enabled.OBSERVER_SPOOL_DIR);expect(files.some(f=>f.endsWith('.jsonl'))).toBe(true);
    const lines=(await Promise.all(files.filter(f=>f.endsWith('.jsonl')).map(f=>readFile(join(enabled.OBSERVER_SPOOL_DIR,f),'utf8')))).join('');expect(lines).toContain('LLM_RESPONSE');
  }finally{await db.query('ALTER TABLE observer_events_unavailable RENAME TO observer_events');}
  await flush();expect((await events()).map(e=>e.eventType)).toContain('LLM_RESPONSE');
});
it('F/G: restart replays a prior spool into PostgreSQL exactly once, even after losing its ack',async()=>{
  const dir=join(root,randomUUID()),options={dir,gitCommit:'fixture',retentionDays:7,maxSpoolMb:4};
  const first=new Recorder(options,{insert:async()=>{throw new Error('database down');}});first.start();first.emit({eventType:'TOOL_ERROR',stage:'before_crash',turnId:'restart-test'});await first.close();
  const second=new Recorder(options,{insert:e=>insertEvents(db,e)});second.start();await second.flush();await second.close();
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.ack')))await rm(join(dir,file));
  const third=new Recorder(options,{insert:e=>insertEvents(db,e)});third.start();await third.flush();await third.close();
  expect((await db.query("SELECT * FROM observer_events WHERE turn_id='restart-test'")).rowCount).toBe(1);
});
it('H: job queued, failed worker and interrupted recovery retain durable correlated evidence',async()=>{
  const turnId=await inbound();
  const job=(await db.query(`INSERT INTO jobs(kind,payload,chat_id,owner_id,source_message_id) SELECT 'media','{"operation":"invalid"}',chat_id,$1,payload->>'id' FROM inbox WHERE turn_id=$2 RETURNING *`,[owner,turnId])).rows[0]!;
  observer.scope({turnId},()=>observer.emit({eventType:'JOB_QUEUED',stage:'fixture',jobId:job.id,payload:job}));
  const claimed=(await claimMedia(db))!;await processMedia(db,enabled,claimed);
  expect((await events(turnId)).map(e=>e.eventType)).toEqual(expect.arrayContaining(['JOB_QUEUED','JOB_STARTED','JOB_FAILED']));
  await db.query("UPDATE jobs SET status='running' WHERE id=$1",[job.id]);await recoverMedia(db,enabled);
  expect((await events()).some(e=>e.eventType==='JOB_RECOVERED' && e.jobId===job.id)).toBe(true);
});
it('I: every attachment registration and public/internal ref survives without binary data',async()=>{
  const id=await context({text:'bot mira',attachments:[{kind:'image',ref:'first',mime:'image/png'},{kind:'image',ref:'second',mime:'image/png'}]},ctx=>observer.scope({turnId:ctx.turnId!},async()=>{
    await backing(ctx,{bytes:png,mime:'image/png'});
    const row=(await ctx.c.query<{id:string}>(`INSERT INTO media_attachments(chat_id,owner_id,source_message_id,artifact_index,is_original,mime,extension,size,sha256,data,expires_at)
      VALUES($1,$2,$3,1,true,'image/png','png',$4,'fixture-hash',$5,clock_timestamp()+interval '7 days') RETURNING id`,[ctx.chat.id,ctx.actor.id,ctx.msg.id,png.length,png])).rows[0]!;
    await registerArtifactV2(ctx.c,'v1_1',{chatId:ctx.chat.id,actorId:ctx.actor.id,sourceMessageId:ctx.msg.id,mediaId:row.id,origin:'user_input'});return ctx.turnId!;
  }));
  const timeline=await events(id),registered=timeline.filter(e=>e.eventType==='ARTIFACT_REGISTERED');
  expect(new Set(registered.map(e=>(e.payload as {artifact:{id:string}}).artifact.id)).size).toBe(2);
  expect(JSON.stringify(timeline)).not.toContain(png.toString('base64'));
});
it('J: disabled observer performs no payload work or writes and returns identical Botsky output',async()=>{
  await stop();const dir=join(root,randomUUID());stop=startObserver({...enabled,OBSERVER_ENABLED:false,OBSERVER_SPOOL_DIR:dir},'app');const payload=vi.fn(()=>{throw new Error('must never evaluate');});observer.emit(payload);
  expect(payload).not.toHaveBeenCalled();await expect(readdir(dir)).rejects.toThrow();
  await context({text:'bot hola'},async ctx=>expect(await route(ctx,{generate:async()=>say})).toBe('Respuesta exacta.'));
});
it('redacts infrastructure secrets recursively, errors and binary fields while preserving normal text/signatures/token usage',()=>{
  const text='hola apiKey token password qué onda, haz estas fotos pidief';
  const output=JSON.stringify(redact({text,apiKey:'one',EVOLUTION_APIKEY:'two',Authorization:'Bearer private',password:'three',nested:{databaseUrl:'postgres://u:p@db/b',cookie:'four',token:'five'},error:new Error('known-secret'),url:'https://cdn.example/file?auth=private-cdn-token',inlineData:{mimeType:'image/png',data:png.toString('base64')},image:{mimeType:'image/png',data:png.toString('base64')},thoughtSignature:'opaque',inputTokens:123},['known-secret']));
  expect(output).toContain(text);expect(output).toContain('opaque');expect(output).toContain('123');for(const secret of ['Bearer private','known-secret',png.toString('base64'),'postgres://u:p','private-cdn-token'])expect(output).not.toContain(secret);
});
it('fail-open includes serialization/getter errors and full/missing spool, with bounded fallback',async()=>{
  const dir=join(root,randomUUID()),persisted:ObserverEvent[]=[];
  const r=new Recorder({dir,gitCommit:'fixture',retentionDays:7,maxSpoolMb:0},{insert:async e=>{persisted.push(...e);}});r.start();
  expect(()=>r.emit({eventType:'TURN_STARTED',stage:'fixture',payload:{get bad(){throw new Error('bad getter');}}})).not.toThrow();
  r.emit({eventType:'TURN_COMPLETED',stage:'fixture'});await r.flush();await r.flush();await r.close();expect(persisted.map(e=>e.eventType)).toContain('TURN_COMPLETED');
});
it('rotates and retains unacknowledged old spool while pruning confirmed old files',async()=>{
  const dir=join(root,randomUUID()),options={dir,gitCommit:'fixture',retentionDays:7,maxSpoolMb:4,rotateBytes:1};
  const r=new Recorder(options,{insert:async()=>{throw new Error('down');}});r.start();r.emit({eventType:'TURN_STARTED',stage:'fixture'});r.emit({eventType:'TURN_COMPLETED',stage:'fixture'});await r.close();
  const files=(await readdir(dir)).filter(f=>f.endsWith('.jsonl'));expect(files).toHaveLength(2);
  const old=new Date(Date.now()-9*86400_000);for(const f of files)await utimes(join(dir,f),old,old);
  const s=new Recorder(options,{insert:async()=>{}});s.start();await s.flush();await s.close();expect((await readdir(dir)).filter(f=>f.endsWith('.jsonl'))).toHaveLength(0);
});
it('measures synchronous ON/OFF overhead with representative structured events',async()=>{
  const r=new Recorder({dir:join(root,randomUUID()),gitCommit:'fixture',retentionDays:7,maxSpoolMb:8},{insert:async()=>{}});r.start();const payload={context:'context '.repeat(1000),args:{body:'exact body'},tokens:{input:100,output:20}};
  const start=performance.now();for(let i=0;i<100;i++)r.emit({eventType:'CONTEXT_BUILT',stage:'benchmark',payload});const ms=performance.now()-start;
  await r.close();console.info(JSON.stringify({observerBenchmark:{events:100,ms,perEventMs:ms/100}}));expect(ms).toBeLessThan(5000);expect(eventTypes.length).toBeGreaterThan(40);
});

it('replayers sharing a spool converge and a truncated prior file cannot block later events',async()=>{
  const dir=join(root,randomUUID()),options={dir,gitCommit:'fixture',retentionDays:7,maxSpoolMb:4};
  const a=new Recorder(options,{insert:e=>insertEvents(db,e)}),b=new Recorder(options,{insert:e=>insertEvents(db,e)});a.start();b.start();
  a.emit({eventType:'TURN_STARTED',stage:'shared',turnId:'shared'});b.emit({eventType:'TURN_COMPLETED',stage:'shared',turnId:'shared'});
  await Promise.all([a.flush(),b.flush()]);await Promise.all([a.close(),b.close()]);
  expect((await db.query("SELECT * FROM observer_events WHERE turn_id='shared'")).rowCount).toBe(2);
  await writeFile(join(dir,'2000-01-01-crashed.jsonl'),'{"eventId":"partial');
  const c=new Recorder(options,{insert:e=>insertEvents(db,e)});c.start();c.emit({eventType:'TURN_COMPLETED',stage:'after_partial',turnId:'after-partial'});await c.flush();await c.flush();await c.close();
  expect((await db.query("SELECT * FROM observer_events WHERE turn_id='after-partial'")).rowCount).toBe(1);
});
it('owner-local exporter joins complete timeline and uses spool during database outage',async()=>{
  const id=await inbound();await flush();
  const invoke=promisify(execFile),args=['--import','tsx','src/observer/cli.ts','turn',id,'--json'];
  const result=await invoke(process.execPath,args,{env:{...process.env,DATABASE_URL:config.DATABASE_URL,OBSERVER_SPOOL_DIR:enabled.OBSERVER_SPOOL_DIR},maxBuffer:4*1024*1024});
  expect(JSON.parse(result.stdout).some((e:ObserverEvent)=>e.turnId===id && e.eventType==='INBOUND_NORMALIZED')).toBe(true);
  const offline=await invoke(process.execPath,args,{env:{...process.env,DATABASE_URL:'postgres://offline:offline@127.0.0.1:1/offline',OBSERVER_SPOOL_DIR:enabled.OBSERVER_SPOOL_DIR},maxBuffer:4*1024*1024});
  expect(JSON.parse(offline.stdout).some((e:ObserverEvent)=>e.turnId===id && e.eventType==='INBOUND_ACCEPTED')).toBe(true);
});
it('compares complete natural turns with observer ON/OFF and preserves identical replies',async()=>{
  const measure=async()=>{const durations:number[]=[];for(let i=0;i<5;i++)await context({text:'bot hola'},ctx=>observer.scope({turnId:ctx.turnId!},async()=>{const start=performance.now();expect(await route(ctx,{generate:async()=>say})).toBe('Respuesta exacta.');durations.push(performance.now()-start);}));return durations.sort((a,b)=>a-b);};
  const on=await measure();await stop();stop=startObserver({...enabled,OBSERVER_ENABLED:false},'app');const off=await measure();
  await writeFile('.local/observer-overhead.json',JSON.stringify({onMs:on,offMs:off,onMedianMs:on[2],offMedianMs:off[2],medianOverheadMs:on[2]!-off[2]!},null,2),{mode:0o600});
});
