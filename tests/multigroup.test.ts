import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { moduleEnabled } from '../src/core/permissions.js';
import { modules } from '../src/core/control-tools.js';
import { receive,processNext } from '../src/core/inbox.js';
import { sendNext } from '../src/wa/outbox.js';
import { MockEvolution } from '../src/wa/mock.js';
import { EvolutionGroups } from '../src/wa/group-control.js';
import { syncEnabledGroups,syncGroupMembers } from '../src/core/membership.js';
import { mediaAllowed } from '../src/modules/media/access.js';
import { libraryAllowed } from '../src/modules/library/access.js';
import { schoolDestination } from '../src/modules/school/automation.js';
import { destinationAllowed,discoverDestinations } from '../src/modules/messaging/access.js';
import { db,config,owner,admin,member,initialize,resetSchool,execute,message,command,context } from './school-harness.js';
const second='800@g.us';
beforeAll(initialize);beforeEach(resetSchool);afterAll(()=>db.end());
const chat=async()=> (await db.query<{id:string;isGroup:boolean;enabled:boolean;settings:{modules?:Record<string,boolean>}}>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[second])).rows[0]!;
const enable=()=>command(message('bot habilita este chat',owner,second));
it('owner enables a second group with all modules off, independently of Lab',async()=>{
  expect(await enable()).toContain('habilitado');const ch=await chat();expect(ch.enabled).toBe(true);for(const m of modules)expect(moduleEnabled(ch,m,config),m).toBe(false);
  expect(await command('bot ping')).toBe('pong');expect(await command(message('bot ping',owner,second))).toBe('pong');
});
it.each([admin,member,'999@lid'])('non-owner %s cannot enable a group',async sender=>{
  expect(await command(message('bot habilita este chat',sender,second))).toBeUndefined();expect(await chat()).toBeUndefined();
});
it('explicit module activation affects only the selected group',async()=>{
  await enable();expect(await command(message('bot nota guarda Segundo',owner,second))).toBe('No.');await command(message('bot activa notas aquí',owner,second));
  expect(await command(message('bot nota guarda Segundo',owner,second))).toContain('Guardé');expect(await command('bot notas')).toBe('No hay notas.');expect(await command(message('bot notas',owner,second))).toContain('Segundo');
  expect(moduleEnabled(await chat(),'polls',config)).toBe(false);
});
it('only owner can change module switches or disable a group',async()=>{
  await enable();await syncGroupMembers(db,second,{id:second,participants:[{id:admin,admin:'admin'}]});
  expect(await command(message('bot activa encuestas aquí',admin,second))).toBe('No.');expect((await execute('control.modules',{module:'polls',enabled:true},admin,second)).ok).toBe(false);
  await command(message('bot deshabilita este chat',admin,second));expect((await chat()).enabled).toBe(true);
});
it('disabling stops queued replies, later processing and every new group delivery',async()=>{
  await enable();await command(message('bot ping',owner,second));
  await command(message('bot deshabilita este chat',owner,second));expect((await chat()).enabled).toBe(false);
  expect(await receive(db,config,message('bot ping',owner,second))).toBe('ignored');
  await db.query('INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,\'after-disabled\')',[second,JSON.stringify({text:'do not send',sourceId:''})]);
  const t=new MockEvolution();while(await sendNext(db,t,config)){await db.query('UPDATE outbox SET sending_at=NULL');}
  expect([...t.deliveries.values()].some(r=>r.delivery.chatId===second)).toBe(false);expect(await command('bot ping')).toBe('pong');
});
it('an input accepted before disable is discarded when processed afterward',async()=>{
  await enable();await receive(db,config,message('bot ping',owner,second));await db.query('UPDATE chats SET enabled=false WHERE id=$1',[second]);await processNext(db,config);expect((await db.query("SELECT * FROM inbox WHERE status='done'")).rowCount).toBe(2);expect((await db.query('SELECT * FROM outbox WHERE chat_id=$1',[second])).rowCount).toBe(1);
});
it('enabled group refresh syncs all groups, never creates or enables unknown chats',async()=>{
  await enable();await db.query("UPDATE chats SET enabled=false WHERE id='400@g.us'");const called:string[]=[];
  await syncEnabledGroups(db,async id=>{called.push(id);return {id,participants:[{id:member}]};});expect(called.sort()).toEqual(['300@g.us',second]);
  expect((await db.query('SELECT * FROM group_memberships WHERE chat_id=$1 AND user_id=$2 AND active',[second,member])).rowCount).toBe(1);
  await syncGroupMembers(db,'999@g.us',{id:'999@g.us',participants:[]});expect((await db.query("SELECT * FROM chats WHERE id='999@g.us'")).rowCount).toBe(0);
});
it('one failed group refresh does not prevent another group refresh',async()=>{
  await enable();await expect(syncEnabledGroups(db,async id=>{if(id==='300@g.us')throw new Error('offline');return {id,participants:[{id:member}]};})).rejects.toThrow('Some');
  expect((await db.query('SELECT * FROM group_memberships WHERE chat_id=$1 AND user_id=$2',[second,member])).rowCount).toBe(1);
});
it('membership from a second group autoapproves private access and disable revokes it',async()=>{
  await enable();await syncGroupMembers(db,second,{id:second,participants:[{id:'700@s.whatsapp.net'}]});
  expect(await command(message('ping','700@s.whatsapp.net','700@s.whatsapp.net'))).toBe('pong');await command(message('bot deshabilita este chat',owner,second));expect(await command(message('ping','700@s.whatsapp.net','700@s.whatsapp.net'))).toBeUndefined();
});
it('no private chat can be enabled through the group mechanism',async()=>{
  expect(await command(message('bot habilita este chat','700@s.whatsapp.net','700@s.whatsapp.net'))).toBeUndefined();
  expect((await db.query("SELECT * FROM chats WHERE id='700@s.whatsapp.net'")).rowCount).toBe(0);
});
it('production adapters and scheduled destinations accept enabled groups only after explicit module activation',async()=>{
  await enable();await context(message('test',owner,second),async ctx=>{
    expect(await mediaAllowed(ctx.c,config,second,owner)).toBe(false);expect(await libraryAllowed(ctx.c,config,second,owner)).toBe(false);expect(await schoolDestination(ctx.c,config,second,owner)).toBe(false);expect(await destinationAllowed(ctx.c,config,second)).toBe(false);
  });
  await syncGroupMembers(db,second,{id:second,subject:'Amigos de prueba',participants:[]});
  for(const module of ['media','library','school','messaging'])await execute('control.modules',{module,enabled:true},owner,second);
  await context(message('test',owner,second),async ctx=>{
    expect(await mediaAllowed(ctx.c,config,second,owner)).toBe(true);expect(await libraryAllowed(ctx.c,config,second,owner)).toBe(true);expect(await schoolDestination(ctx.c,config,second,owner)).toBe(true);expect(await destinationAllowed(ctx.c,config,second)).toBe(true);
    expect((await discoverDestinations(ctx.c,config)).find(d=>d.target_id===second)?.label).toBe('Amigos de prueba');
  });
});
it('group-control uses persistent authorization for second-group requests',async()=>{
  await enable();const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({id:second,participants:[]}));
  try{const groups=new EvolutionGroups(config,db);expect((await groups.roster(second)).id).toBe(second);await db.query('UPDATE chats SET enabled=false WHERE id=$1',[second]);await expect(groups.roster(second)).rejects.toThrow('disabled');expect(fetch).toHaveBeenCalledTimes(1);}finally{fetch.mockRestore();}
});
it('ambiguous canonical identities cannot grant membership/admin in any enabled group',async()=>{
  await enable();await expect(syncGroupMembers(db,second,{id:second,participants:[{id:'701@lid',phoneNumber:member},{id:'702@lid',phoneNumber:member,admin:'admin'}]})).rejects.toThrow();expect((await db.query('SELECT * FROM group_memberships WHERE chat_id=$1',[second])).rowCount).toBe(0);
});
it('a private JID cannot masquerade as a group to execute enable',async()=>{
  expect(await receive(db,config,{...message('bot habilita este chat',owner,owner),isGroup:true})).toBe('ignored');
});
it('reminder tick and delivery work in an explicitly activated second group',async()=>{
  const {tickCore}=await import('../src/modules/reminders/tick.js');await enable();await command(message('bot activa recordatorios aquí',owner,second));await command(message('bot recordatorio en 2 minutos Segundo',owner,second));
  await db.query("UPDATE reminders SET due_at=now()-interval '1 minute' WHERE chat_id=$1",[second]);await tickCore(db,config);expect((await db.query("SELECT * FROM outbox WHERE chat_id=$1 AND dedupe_key LIKE 'reminder:%'",[second])).rowCount).toBe(1);
  const t=new MockEvolution();for(let i=0;i<10;i++){await db.query('UPDATE outbox SET sending_at=NULL');if(!await sendNext(db,t,config))break;}expect([...t.deliveries.values()].some(r=>r.delivery.chatId===second && r.delivery.text.includes('Recordatorio #'))).toBe(true);
});
it('polls in two enabled groups retain distinct votes and results',async()=>{
  await enable();await command(message('bot activa encuestas aquí',owner,second));await execute('polls.create',{question:'Lab',options:['a','b']});await execute('polls.create',{question:'Segundo',options:['a','b']},owner,second);
  const rows=(await db.query<{id:string;chat_id:string}>('SELECT id,chat_id FROM polls ORDER BY id')).rows;const local=rows.find(r=>r.chat_id===second)!;await execute('polls.vote',{id:local.id,option:2},owner,second);
  expect((await execute('polls.results',{id:local.id},owner,second))).toMatchObject({ok:true,reply:expect.stringContaining('2. b: 1')});expect((await execute('polls.results',{id:rows[0]!.id}))).toMatchObject({ok:true,reply:expect.stringContaining('2. b: 0')});
});

it('Nuclear preview names the actual group without claiming it is Lab',async()=>{
  await enable();await command(message('bot activa mensajería aquí',owner,second));const reply=await command(message('bot nuclear 5 | Prueba local',owner,second));expect(reply).toContain('Grupo actual');expect(reply).not.toContain('Botsky Lab');
});
