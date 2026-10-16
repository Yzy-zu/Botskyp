import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn,execFileSync } from 'node:child_process';
import { db,config,owner,admin,member,initialize,resetSchool,context,message,command } from './school-harness.js';
import { createRegistry } from '../src/core/registry.js';
import { receive,processNext } from '../src/core/inbox.js';
import * as minecraftClient from '../src/modules/minecraft/client.js';
import { callMinecraft,sshArguments } from '../src/modules/minecraft/client.js';
import { requestSchema,parseResponse,type Action,type Response } from '../src/modules/minecraft/protocol.js';
import { recoverMinecraft,tickMinecraft } from '../src/modules/minecraft/service.js';
import { permitted } from '../src/core/permissions.js';
import { minecraftShortcut } from '../src/modules/minecraft/shortcuts.js';
const enabled={...config,MINECRAFT_ENABLED:true};
const state={online:true,running:true,startedAt:'2026-10-16T10:00:00Z',uptimeSeconds:1,players:0,maxPlayers:10};
function response(id:string,action:Action,data:unknown=state):Response{return {v:1,id,action,ok:true,code:'ok',data};}
async function run(name:string,args:unknown={},sender=owner,input=message('bot prueba',sender)){
  return context(input,ctx=>createRegistry().execute(ctx,name,args),{config:enabled});
}
async function enqueue(action='start'){
  const output=await run(`minecraft.${action}`);
  expect(output.ok).toBe(true);
  return (await db.query<{id:string}>('SELECT id FROM minecraft_operations ORDER BY created_at DESC LIMIT 1')).rows[0]!.id;
}
beforeAll(initialize);
afterAll(()=>db.end());
afterEach(()=>vi.restoreAllMocks());
beforeEach(async()=>{await db.query('TRUNCATE minecraft_operations');await resetSchool();});
describe('Minecraft permissions and queue',()=>{
  it.each([admin,member,'700@s.whatsapp.net','100@lid'])('rejects infrastructure actor %s',async actor=>{
    expect(await run('minecraft.start',{},actor)).toMatchObject({ok:false,message:'No.'});
    expect((await db.query('SELECT id FROM minecraft_operations')).rowCount).toBe(0);
  });
  it('requires a current member for reads and isolates private chats',()=>{
    const chat={id:'300@g.us',enabled:true,isGroup:true,settings:{}};
    expect(permitted({id:member,role:'member',groupMember:true},chat,'minecraft.read')).toBe(true);
    expect(permitted({id:member,role:'member',groupMember:false},chat,'minecraft.read')).toBe(false);
    expect(permitted({id:member,role:'member',groupMember:true},{...chat,isGroup:false},'minecraft.read')).toBe(false);
  });
  it('offers reads but no infrastructure tools to members and none to strangers',async()=>{
    for(const [actor,expected] of [[member,['minecraft.status','minecraft.players']],['700@s.whatsapp.net',[]]] as const){
      await context(message('bot ayuda',actor),async ctx=>expect(createRegistry().available(ctx).filter(t=>t.module==='minecraft').map(t=>t.name)).toEqual(expected));
    }
  });
  it('offers only argument-free reads to Gemini',async()=>{
    await context(message('bot ayuda'),async ctx=>expect(createRegistry().available(ctx,true).filter(t=>t.module==='minecraft').map(t=>t.name)).toEqual(['minecraft.status','minecraft.players']));
    expect(requestSchema.safeParse({action:'start',args:{host:'evil',actor:owner}}).success).toBe(false);
  });
  it('keeps disabled module and missing configuration inert',async()=>{
    expect(await context(message('bot'),ctx=>createRegistry().execute(ctx,'minecraft.start',{}))).toMatchObject({ok:false});
    await db.query(`UPDATE chats SET settings='{"modules":{"minecraft":false}}'`);
    expect(await run('minecraft.start')).toMatchObject({ok:false});
  });
  it.each(['stop','restart'])('requires confirmation for %s and rechecks permission',async action=>{
    const result=await run(`minecraft.${action}`);
    expect(result).toMatchObject({ok:true});
    expect((await db.query('SELECT id FROM minecraft_operations')).rowCount).toBe(0);
    expect(await command('sí',member)).toBeUndefined();
    await db.query(`UPDATE chats SET settings='{"modules":{"minecraft":false}}' WHERE id=$1`,[config.LAB_CHAT_ID]);
    expect(await command('sí')).toBe('No.');
  });
  it.each([true,false])('audits a permitted member read, available=%s',async available=>{
    vi.spyOn(minecraftClient,'callMinecraft').mockImplementation(async(req,id)=>{
      if(!available)throw new Error('SSH unavailable');
      return response(id!,req.action);
    });
    expect((await run('minecraft.status',{},member)).ok).toBe(available);
    const audit=(await db.query("SELECT actor_id,detail FROM audit_log WHERE action='minecraft.read'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(member);
    expect(audit[0].detail).toMatchObject({target:'redspi',action:'status',status:available?'observed':'unavailable'});
  });
  it.each(['failed','conflict'] as const)('keeps unexpected remote %s outcomes for review',async code=>{
    await enqueue();
    await tickMinecraft(db,enabled,async(req,id)=>({...response(id!,req.action),ok:false,code,data:null}));
    expect((await db.query('SELECT status FROM minecraft_operations')).rows[0].status).toBe('review');
  });
  it('persists a confirmed restart only once',async()=>{
    await run('minecraft.restart');
    const input=message('sí');
    await receive(db,enabled,input);await processNext(db,enabled);
    expect(await receive(db,enabled,input)).toBe('duplicate');
    expect((await db.query('SELECT id FROM minecraft_operations')).rowCount).toBe(1);
    const client=vi.fn(async(request,id)=>response(id!,request.action));
    await tickMinecraft(db,enabled,client);await tickMinecraft(db,enabled,client);
    expect(client).toHaveBeenCalledTimes(1);
  });
  it('deduplicates a write at tool level and webhook level',async()=>{
    const input=message('bot mc start');
    await run('minecraft.start',{},owner,input);await run('minecraft.start',{},owner,input);
    expect((await db.query('SELECT id FROM minecraft_operations')).rowCount).toBe(1);
    await db.query('TRUNCATE minecraft_operations');
    await receive(db,enabled,input);expect(await receive(db,enabled,input)).toBe('duplicate');
    await processNext(db,enabled);await processNext(db,enabled);
    expect((await db.query('SELECT id FROM minecraft_operations')).rowCount).toBe(1);
  });
  it('serializes backups across chats and keeps queued work after restart',async()=>{
    await enqueue('backup');
    expect(await run('minecraft.backup')).toMatchObject({ok:false});
    await recoverMinecraft(db);
    const client=vi.fn(async(request,id)=>response(id!,request.action,{file:`${id}.tar`,bytes:10240,sha256:'a'.repeat(64)}));
    await Promise.all([tickMinecraft(db,enabled,client),tickMinecraft(db,enabled,client)]);
    expect(client).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT status FROM minecraft_operations')).rows[0].status).toBe('done');
    expect((await db.query("SELECT * FROM audit_log WHERE action='minecraft.result'")).rowCount).toBe(1);
  });
  it('recovers interrupted sending as review and never repeats it',async()=>{
    await enqueue();await db.query("UPDATE minecraft_operations SET status='sending'");
    await recoverMinecraft(db);await recoverMinecraft(db);
    const client=vi.fn();await tickMinecraft(db,enabled,client);
    expect(client).not.toHaveBeenCalled();
    expect((await db.query('SELECT status FROM minecraft_operations')).rows[0].status).toBe('review');
    expect((await db.query("SELECT id FROM outbox WHERE dedupe_key LIKE 'minecraft:%:result'")).rowCount).toBe(1);
    expect(await run('minecraft.start')).toMatchObject({ok:false});
  });
  it('survives SIGKILL after durable sending without replay',async()=>{
    await enqueue();
    const child=spawn(process.execPath,['--import','tsx','tests/minecraft-runtime-child.ts'],{stdio:['ignore','pipe','pipe']});
    try{
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Child did not reach committed sending')),8000);
        child.stdout.on('data',(chunk:Buffer)=>{if(chunk.toString().includes('sending-committed')){clearTimeout(timer);resolve();}});
        child.once('error',reject);
        child.once('exit',code=>{if(code!==null){clearTimeout(timer);reject(new Error('Child exited early'));}});
      });
      const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
      child.kill('SIGKILL');await exited;
      await recoverMinecraft(db);
      const client=vi.fn();await tickMinecraft(db,enabled,client);
      expect(client).not.toHaveBeenCalled();
      expect((await db.query('SELECT status FROM minecraft_operations')).rows[0].status).toBe('review');
    }finally{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');}
  });
  it('cancels queued work on owner revocation before SSH',async()=>{
    await enqueue();
    const client=vi.fn();await tickMinecraft(db,{...enabled,OWNER_JIDS:['900@s.whatsapp.net']},client);
    expect(client).not.toHaveBeenCalled();
    expect((await db.query('SELECT status FROM minecraft_operations')).rows[0].status).toBe('cancelled');
  });
  it.each(['emergency','maintenance'])('does not send queued work during %s',async key=>{
    await enqueue();await db.query('INSERT INTO system_flags(key,value) VALUES($1,\'true\')',[key]);
    const client=vi.fn();await tickMinecraft(db,enabled,client);expect(client).not.toHaveBeenCalled();
  });
  it.each(['ssh','timeout','protocol'])('retains uncertainty and audit after %s failure',async kind=>{
    await enqueue();const client=vi.fn(async()=>{throw new Error(kind);});
    await tickMinecraft(db,enabled,client);await tickMinecraft(db,enabled,client);
    expect(client).toHaveBeenCalledTimes(1);
    expect((await db.query('SELECT status FROM minecraft_operations')).rows[0].status).toBe('review');
    expect((await db.query("SELECT detail FROM audit_log WHERE action='minecraft.result'")).rows[0].detail.status).toBe('review');
  });
});
describe('Minecraft SSH boundary',()=>{
  it.each(['rm -rf /','list; id','$(touch /tmp/owned)','list\nstop','--help','time set day && id'])('rejects shell/console input %s',command=>{
    expect(requestSchema.safeParse({action:'console',args:{command}}).success).toBe(false);
  });
  it('keeps invalid Minecraft syntax away from Gemini',()=>{
    expect(minecraftShortcut('mc console list; id')).toMatchObject({name:'minecraft.console'});
    expect(minecraftShortcut('mc start; id')).toMatchObject({name:'minecraft.invalid'});
    expect(minecraftShortcut('mc config-set pvp false')).toMatchObject({name:'minecraft.config-set',args:{key:'pvp',value:'false'}});
  });
  it('pins host, identity and host key and sends a fixed alphabet',()=>{
    const args=sshArguments({action:'console',args:{command:'time set day'}},randomUUID());
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('botsky-mc@100.104.54.2');
    expect(args.at(-1)).toMatch(/^v1 [a-f0-9-]{36} [A-Za-z0-9_-]+$/);
  });
  it.each([{code:255},{code:'ENOENT'},{killed:true}])('classifies inaccessible/SSH/timeout failure %j',async error=>{
    await expect(callMinecraft({action:'status',args:{}},randomUUID(),async()=>{throw error;})).rejects.toMatchObject({kind:'killed' in error?'timeout':'ssh'});
  });
  it.each(['not json',JSON.stringify({ok:true}),JSON.stringify(response(randomUUID(),'status')),JSON.stringify({...response('00000000-0000-4000-8000-000000000000','status'),data:{online:true}})])('rejects unexpected wrapper response',async stdout=>{
    await expect(callMinecraft({action:'status',args:{}},randomUUID(),async()=>({stdout}))).rejects.toMatchObject({kind:'protocol'});
  });
  it('accepts a strict response and applies the read timeout',async()=>{
    const id=randomUUID();const runner=vi.fn(async()=>({stdout:JSON.stringify(response(id,'status'))}));
    expect(await callMinecraft({action:'status',args:{}},id,runner)).toMatchObject({ok:true});
    expect(runner.mock.calls[0]).toBeDefined();
    expect(parseResponse(JSON.stringify(response(id,'status')),id,'status').data).toEqual(state);
  });
  it('runs remote wrapper security, idempotency and backup tests without a real server',()=>{
    expect(execFileSync('python3',['scripts/minecraft/test_gateway.py'],{encoding:'utf8'})).toContain('gateway tests passed');
  });
});
