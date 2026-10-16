import * as sources from '../src/modules/media/sources.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { mkdtemp,writeFile,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db,config,owner,member,message,context,command,initialize,resetSchool } from './school-harness.js';
import { createRegistry } from '../src/core/registry.js';
import { claimMedia,processMedia,recoverMedia,retainMedia,type WorkerDeps } from '../src/modules/media/worker.js';
import { reportMediaDeliveries } from '../src/modules/media/delivery.js';
import { enqueueMedia } from '../src/modules/media/service.js';
import { sendNext } from '../src/wa/outbox.js';
import type { Transport } from '../src/wa/types.js';
import { requestSchema } from '../src/modules/media/catalog.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=','base64');
let root:string;
let deps:WorkerDeps;
beforeAll(async()=>{await initialize();root=await mkdtemp(join(tmpdir(),'botsky-job-test-'));});
beforeEach(async()=>{
  vi.restoreAllMocks();await resetSchool();await db.query('TRUNCATE media_attachments,jobs CASCADE');
  deps={root,download:vi.fn(async()=>({bytes:png,mime:'image/png',url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.png'})),attachment:vi.fn(async()=>({bytes:png,mime:'image/png'})),process:vi.fn(async cwd=>{await writeFile(join(cwd,'result.png'),png);return {files:['result.png']};})};
});
afterAll(async()=>{await rm(root,{recursive:true,force:true});await db.end();});
const queue=(input=message('bot qr test'))=>context(input,ctx=>createRegistry().execute(ctx,'media.process',{operation:'qr_create',text:'test'}));
async function run(){const job=await claimMedia(db);expect(job).toBeDefined();await processMedia(db,config,job!,deps);return job!;}
const transport:Transport={state:async()=>true,send:vi.fn(async()=>({status:'sent',id:'provider-confirmed'} as const)),reconcile:async()=>({status:'unknown'})};
describe('durable media queue',()=>{
  it('records acceptance, processing and confirmed delivery separately',async()=>{
    const accepted=await queue();expect(accepted.ok && accepted.reply).toContain('todavía no se ha entregado');const job=await run();
    const row=(await db.query('SELECT status,outbox_id FROM jobs WHERE id=$1',[job.id])).rows[0];expect(row.status).toBe('done');
    expect((await db.query('SELECT status FROM outbox WHERE id=$1',[row.outbox_id])).rows[0].status).toBe('queued');
    await sendNext(db,transport,config);
    expect((await db.query('SELECT status FROM outbox WHERE id=$1',[row.outbox_id])).rows[0].status).toBe('sent');
    const delivery=vi.mocked(transport.send).mock.calls.at(-1)![0];expect(delivery.chatId).toBe(config.LAB_CHAT_ID);expect(delivery.media?.mime).toBe('image/png');
    expect(await readdir(root)).toEqual([]);
  });
  it('dedupes the same actor/chat/message before and after completion',async()=>{
    const msg=message('bot qr test');await queue(msg);await queue(msg);expect((await db.query('SELECT * FROM jobs')).rowCount).toBe(1);
    await run();await queue(msg);expect((await db.query('SELECT * FROM jobs')).rowCount).toBe(1);expect((await db.query("SELECT * FROM outbox WHERE kind='media_result'")).rowCount).toBe(1);
  });
  it('limits two active jobs per actor across chats, including concurrent requests',async()=>{
    const results=await Promise.all([queue(),queue(),queue()]);expect(results.filter(r=>r.ok)).toHaveLength(2);expect((await db.query("SELECT * FROM jobs WHERE status='queued'")).rowCount).toBe(2);
  });
  it('blocks a disabled module at acceptance and at worker execution',async()=>{
    await queue();await db.query(`UPDATE chats SET settings='{"modules":{"media":false}}' WHERE id=$1`,[config.LAB_CHAT_ID]);
    expect((await queue()).ok).toBe(false);await run();expect(deps.process).not.toHaveBeenCalled();expect((await db.query('SELECT status,error FROM jobs')).rows[0]).toMatchObject({status:'failed',error:'not_allowed'});
  });
  it('blocks a removed member before processing',async()=>{
    await queue(message('bot qr test',member));await db.query('UPDATE group_memberships SET active=false WHERE user_id=$1',[member]);await run();expect(deps.process).not.toHaveBeenCalled();
  });
  it('blocks delivery after permissions change and reports the failure once',async()=>{
    await queue();await run();await db.query(`UPDATE chats SET settings='{"modules":{"media":false}}' WHERE id=$1`,[config.LAB_CHAT_ID]);
    await sendNext(db,transport,config);expect((await db.query("SELECT status FROM outbox WHERE kind='media_result'")).rows[0].status).toBe('failed');
    await reportMediaDeliveries(db);await reportMediaDeliveries(db);expect((await db.query("SELECT * FROM outbox WHERE dedupe_key LIKE 'media:delivery-problem:%'")).rowCount).toBe(1);
  });
  it('does not repeat an uncertain media send or label it delivered',async()=>{
    await queue();await run();const send=vi.fn(async()=>({status:'uncertain',reason:'timeout'} as const));
    const t={...transport,send};await sendNext(db,t,config);
    await db.query("UPDATE outbox SET next_try_at=now() WHERE kind='media_result'");await sendNext(db,t,config);
    expect(send).toHaveBeenCalledTimes(1);expect((await db.query("SELECT status FROM outbox WHERE kind='media_result'")).rows[0].status).toBe('uncertain');
    expect(await command('bot trabajos')).toContain('incierta, sin repetir');
  });
  it('fails conservatively on ffmpeg failure and cleans temporary files',async()=>{
    deps.process=vi.fn(async()=>{throw new Error('process_failed');});await queue();await run();
    expect((await db.query('SELECT status,error FROM jobs')).rows[0]).toMatchObject({status:'failed',error:'process_failed'});expect(await readdir(root)).toEqual([]);
    expect((await db.query("SELECT * FROM outbox WHERE kind='media_result'")).rowCount).toBe(0);
  });
  it('handles a timeout honestly',async()=>{
    deps.process=vi.fn(async()=>{throw new Error('process_timeout');});await queue();await run();
    expect((await db.query('SELECT payload FROM outbox')).rows[0].payload.text).toContain('Se agotó el tiempo');
  });
  it('recovers running work, caps attempts and queues one final notice',async()=>{
    await queue();await claimMedia(db);await recoverMedia(db);await claimMedia(db);await recoverMedia(db);await claimMedia(db);await recoverMedia(db);await recoverMedia(db);
    expect((await db.query('SELECT status,attempts,error FROM jobs')).rows[0]).toMatchObject({status:'failed',attempts:3,error:'interrupted'});
    expect((await db.query('SELECT * FROM outbox')).rowCount).toBe(1);
  });
  it('keeps pong responsive while a heavy job is blocked',async()=>{
    let release:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{release=resolve;});deps.process=vi.fn(async cwd=>{await waiting;await writeFile(join(cwd,'result.png'),png);return {files:['result.png']};});
    await queue();const job=await claimMedia(db);const work=processMedia(db,config,job!,deps);
    try{expect(await command('bot ping')).toBe('pong');}finally{release();await work;}
  });
  it('survives a real SIGKILL during processing with one eventual delivery',async()=>{
    await queue();
    const child=fork(new URL('./media-restart-child.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,MEDIA_TEST_ROOT:root},stdio:['ignore','ignore','ignore','ipc']});
    try{
      const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('child exited before processing');})]);
      expect(ready[0]).toBe('processing');child.kill('SIGKILL');await once(child,'exit');
      await recoverMedia(db);await run();expect((await db.query("SELECT count(*) n FROM outbox WHERE kind='media_result'")).rows[0].n).toBe('1');
      expect(await readdir(root)).toEqual([]);
    }finally{if(child.exitCode===null)child.kill('SIGKILL');}
  });
  it('does not retry processed jobs after restart or duplicate final deliveries',async()=>{
    await queue();await run();await recoverMedia(db);expect(await claimMedia(db)).toBeUndefined();expect((await db.query("SELECT * FROM outbox WHERE kind='media_result'")).rowCount).toBe(1);
  });
  it('rejects model-injected paths, actors, formats and command arguments',()=>{
    for(const args of [{operation:'mp3',actor:owner},{operation:'mp3',path:'/etc/passwd'},{operation:'mp3',ffmpegArgs:['-i','x']},{operation:'mp3;touch /tmp/pwned'},{operation:'mp3',sources:[]}])expect(requestSchema.safeParse(args).success).toBe(false);
  });
  it('does not allow URL bypasses through the tool',async()=>{
    for(const url of ['file:///etc/passwd','https://127.0.0.1/test','https://youtube.com/watch?v=x']){
      const result=await context(message('bot descarga'),ctx=>enqueueMedia(ctx,{operation:'download',url}));expect(result.ok).toBe(false);
    }expect((await db.query('SELECT * FROM jobs')).rowCount).toBe(0);
  });
  it('scopes job status to actor and chat',async()=>{
    await queue();const response=await command('bot trabajos',member);expect(response).toBe('No tienes trabajos en este chat.');
  });
  it('enforces originals 7 days and generated artifacts 2 days with idempotent cleanup',async()=>{
    const msg=message('bot descarga https://upload.wikimedia.org/wikipedia/commons/a/ab/X.png');
    await context(msg,ctx=>enqueueMedia(ctx,{operation:'download',url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.png'}));await run();
    const rows=(await db.query<{is_original:boolean;days:number}>('SELECT is_original,extract(epoch FROM expires_at-created_at)/86400 days FROM media_attachments ORDER BY is_original DESC')).rows;
    expect(Number(rows[0]!.days)).toBeCloseTo(7,2);expect(Number(rows[1]!.days)).toBeCloseTo(2,2);
    await db.query('UPDATE media_attachments SET expires_at=now()-interval \'1 second\' WHERE NOT is_original');await retainMedia(db);await retainMedia(db);
    expect((await db.query('SELECT data IS NOT NULL present FROM media_attachments WHERE is_original')).rows[0].present).toBe(true);
    expect((await db.query('SELECT data IS NULL absent FROM media_attachments WHERE NOT is_original')).rows[0].absent).toBe(true);
  });
  it('refuses expired generated artifacts at delivery time',async()=>{
    await queue();await run();await db.query("UPDATE media_attachments SET expires_at=now()-interval '1 second'");await sendNext(db,transport,config);
    expect((await db.query("SELECT status FROM outbox WHERE kind='media_result'")).rows[0].status).toBe('failed');
  });
  it('collects only files from its owner/chat and finishes without occupying foreground during processing',async()=>{
    expect(await command('bot junta estas fotos en un PDF')).toContain('Voy a reunir');
    const other=message('',member);other.attachments=[{kind:'image',ref:`${other.id}:image`,mime:'image/png'}];await command(other,member);
    const own=message('');own.attachments=[{kind:'image',ref:`${own.id}:image`,mime:'image/png'}];expect(await command(own)).toContain('Archivo 1');
    expect(await command('terminar')).toContain('Trabajo #');
    const row=(await db.query('SELECT payload FROM jobs')).rows[0];expect(row.payload.sources).toHaveLength(1);expect(row.payload.sources[0].senderId).toBe(owner);
    expect((await db.query("SELECT * FROM sessions WHERE status='active'")).rowCount).toBe(0);
  });
  it('opens a persisted selection and accepts only its owner number without Gemini',async()=>{
    vi.spyOn(sources,'searchMedia').mockResolvedValue([{title:'File:Hello.ogg',url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Hello.ogg',mime:'audio/ogg',size:9000,page:'https://commons.wikimedia.org/wiki/File:Hello.ogg'}]);
    expect(await command('bot busca música saludo')).toContain('Elige un número');
    expect(await command('1',member)).toBeUndefined();expect((await db.query('SELECT * FROM jobs')).rowCount).toBe(0);
    expect(await command('1')).toContain('Trabajo #');expect((await db.query('SELECT * FROM jobs')).rowCount).toBe(1);
    expect((await db.query('SELECT payload FROM jobs')).rows[0].payload.url).toContain('upload.wikimedia.org');
  });
  it('expires selections and rejects stale/foreign continuations',async()=>{
    vi.spyOn(sources,'searchMedia').mockResolvedValue([{title:'File:Hello.ogg',url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Hello.ogg',mime:'audio/ogg',size:9000,page:'https://commons.wikimedia.org/wiki/File:Hello.ogg'}]);
    await command('bot busca música saludo');await db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
    expect(await command('1')).toBeUndefined();expect((await db.query('SELECT * FROM jobs')).rowCount).toBe(0);
  });
  it('can reuse a confirmed generated attachment quoted by its owner without refetching WhatsApp',async()=>{
    await queue();await run();await sendNext(db,transport,config);
    const msg=message('bot convierte a png');msg.quoted={id:'provider-confirmed',fromBot:true};
    const result=await context(msg,ctx=>createRegistry().execute(ctx,'media.process',{operation:'png'}));expect(result.ok).toBe(true);
    await run();expect(deps.attachment).not.toHaveBeenCalled();
    const foreign=message('bot convierte a png',member);foreign.quoted={id:'provider-confirmed',fromBot:true};
    const blocked=await context(foreign,ctx=>createRegistry().execute(ctx,'media.process',{operation:'png'}));expect(blocked.ok).toBe(false);
  });
  it('does not fetch attachment keys without an accepted original message',async()=>{
    const source=message('');source.attachments=[{kind:'image',ref:`${source.id}:image`,mime:'image/png'}];
    await context(message('test'),ctx=>enqueueMedia(ctx,{operation:'png'},[source]));await run();expect(deps.attachment).not.toHaveBeenCalled();expect((await db.query('SELECT error FROM jobs')).rows[0].error).toBe('invalid_attachment_provenance');
  });
});
