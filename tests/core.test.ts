import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
import { createDb,transaction } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { readConfig } from '../src/config.js';
import { receive,processNext } from '../src/core/inbox.js';
import { route,llmError,rememberContext } from '../src/core/router.js';
import { geminiKeyPool, GeminiAttemptError } from '../src/core/gemini-key-pool.js';
import { LlmUnavailable } from '../src/core/llm.js';
import { createRegistry } from '../src/core/registry.js';
import { actorFor,permitted,type Actor,type Chat } from '../src/core/permissions.js';
import { activeSession,argumentHash,openSession } from '../src/core/sessions.js';
import { compose } from '../src/core/composer.js';
import { tickCore } from '../src/modules/reminders/tick.js';
import { sendNext } from '../src/wa/outbox.js';
import { MockEvolution } from '../src/wa/mock.js';
import { sensitiveMemory } from '../src/modules/memory/index.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg } from '../src/wa/types.js';
const {url}=JSON.parse(readFileSync('.local/test-db.json','utf8')) as {url:string};
if(!new URL(url).pathname.startsWith('/botsky_test_'))throw new Error('Unsafe test database');
const db=createDb(url);
const config=readConfig({ROUTER_MODE:'v1',GEMINI_API_KEY:'fixture-gemini-key',DATABASE_URL:url,EVOLUTION_URL:'http://mock',EVOLUTION_APIKEY:'test',INSTANCE:'test',WEBHOOK_SECRET:'x'.repeat(32),OWNER_JIDS:'100@s.whatsapp.net',BOT_JIDS:'200@s.whatsapp.net',LAB_CHAT_ID:'300@g.us',TRANSPORT:'mock'});
const msg=(text:string,senderId='100@s.whatsapp.net',chatId=config.LAB_CHAT_ID):Msg=>({id:randomUUID(),chatId,senderId,isGroup:chatId.endsWith('@g.us'),ts:new Date(),text,fromMe:false,mentions:[],attachments:[]});
async function command(text:string,sender='100@s.whatsapp.net',chat=config.LAB_CHAT_ID):Promise<string|undefined>{
  const input=msg(text,sender,chat);await receive(db,config,input);await processNext(db,config);
  return (await db.query<{payload:{text:string}}>("SELECT payload FROM outbox WHERE payload->>'sourceId'=$1",[input.id])).rows[0]?.payload.text;
}
async function withContext<T>(text:string,fn:(ctx:ToolCtx)=>Promise<T>,sender='100@s.whatsapp.net',chatId=config.LAB_CHAT_ID):Promise<T>{
  return transaction(db,async c=>{
    const input=msg(text,sender,chatId);const actor=await actorFor(c,input,config);
    const row=(await c.query<{enabled:boolean;settings:Chat['settings']}>('SELECT enabled,settings FROM chats WHERE id=$1',[chatId])).rows[0]!;
    return fn({actor,chat:{id:chatId,isGroup:input.isGroup,...row},msg:input,db,c,config,now:new Date(),search:async()=> 'Resultado exacto #18 · https://example.com'});
  });
}
beforeAll(()=>migrate(db));
afterAll(()=>db.end());
beforeEach(async()=>{
  await db.query('TRUNCATE inbox,seen_events,outbox,chats,users,user_aliases,group_memberships,system_flags,error_log,sessions,notes,reminders,user_memories,context_msgs,llm_usage,llm_cooldowns,audit_log CASCADE');
  await db.query("INSERT INTO chats(id,is_group,enabled) VALUES('300@g.us',true,true),('400@g.us',true,true),('100@s.whatsapp.net',false,true)");
  await db.query("INSERT INTO users(id) VALUES('100@s.whatsapp.net'),('500@s.whatsapp.net'),('600@s.whatsapp.net')");
  await db.query("INSERT INTO group_memberships(chat_id,user_id,is_admin) VALUES('300@g.us','500@s.whatsapp.net',true),('400@g.us','500@s.whatsapp.net',false),('300@g.us','600@s.whatsapp.net',false)");
});
it('deterministic shortcuts persist notes and missing-date reminders with zero AI usage',async()=>{
  expect(await command('Botsky, guarda que la reunión será el viernes.')).toContain('Guardé la nota #');
  expect(await command('bot notas busca reunión')).toContain('reunión será el viernes');
  expect(await command('Bot, recuérdame entregar el proyecto.')).toContain('¿Cuándo');
  expect(await command('Mañana a las 8 de la mañana.')).toContain('08:00');
  expect((await db.query('SELECT * FROM llm_usage')).rowCount).toBe(0);
  expect((await db.query('SELECT * FROM reminders')).rowCount).toBe(1);
});
it('rejects ambiguous eight and keeps the pending clarification',async()=>{
  await command('bot recuérdame estudiar');
  await command('Mañana a las ocho');
  expect((await db.query('SELECT * FROM reminders')).rowCount).toBe(0);
  expect((await db.query("SELECT * FROM sessions WHERE status='active'")).rowCount).toBe(1);
  expect(await command('Mañana a las ocho de la noche')).toContain('20:00');
});
it('session ownership and foreground uniqueness survive a fresh DB connection',async()=>{
  await command('bot recuérdame entregar el proyecto');
  expect(await command('Mañana a las 8 de la mañana','600@s.whatsapp.net')).toBeUndefined();
  const fresh=createDb(url);expect((await fresh.query("SELECT * FROM sessions WHERE status='active'")).rowCount).toBe(1);await fresh.end();
  await withContext('x',async ctx=>{await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'clarify',{action:'reminders.create',args:{body:'nuevo'}},['fecha']);});
  expect((await db.query("SELECT * FROM sessions WHERE status='active'")).rowCount).toBe(1);
});
it('confirmation rejects another actor, another chat, tampered args, replay and expiry',async()=>{
  await command('bot nota guarda reunión');
  const id=(await db.query<{id:string}>('SELECT id FROM notes')).rows[0]!.id;
  await command(`bot nota borra ${id}`);
  expect(await command('sí','600@s.whatsapp.net')).toBeUndefined();
  expect(await command('sí','100@s.whatsapp.net','100@s.whatsapp.net')).toContain('No tienes');
  await db.query("UPDATE sessions SET state=jsonb_set(state,'{args,id}','\"999\"')");
  expect(await command('sí')).toContain('no es válida');
  expect((await db.query('SELECT deleted_at FROM notes')).rows[0]?.deleted_at).toBeNull();
  await command(`bot nota borra ${id}`);await db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE status='active'");
  expect(await command('bot sí')).toContain('No tienes');
  await command(`bot nota borra ${id}`);expect(await command('sí')).toContain(`Eliminé la nota #${id}`);
  expect(await command('bot sí')).toContain('No tienes');
});
it('rechecks permissions at confirmation execution after administrator demotion',async()=>{
  await command('bot nota guarda original');const id=(await db.query<{id:string}>('SELECT id FROM notes')).rows[0]!.id;
  expect(await command(`bot nota borra ${id}`,'500@s.whatsapp.net')).toContain('Confirma');
  await db.query("UPDATE group_memberships SET is_admin=false WHERE user_id='500@s.whatsapp.net'");
  expect(await command('sí','500@s.whatsapp.net')).toBe('No.');
  expect((await db.query('SELECT deleted_at FROM notes')).rows[0]?.deleted_at).toBeNull();
});
it('shared notes require authorship or admin in the exact group; private search is scoped',async()=>{
  await command('bot nota guarda secreto','100@s.whatsapp.net','100@s.whatsapp.net');
  expect(await command('bot notas busca secreto')).toBe('No hay notas.');
  await command('bot nota guarda compartida');const id=(await db.query<{id:string}>("SELECT id FROM notes WHERE body='compartida'")).rows[0]!.id;
  expect(await command(`bot nota edita ${id} hack`,'600@s.whatsapp.net')).toBe('No.');
  expect(await command(`bot nota edita ${id} válido`,'500@s.whatsapp.net')).toContain('Actualicé');
  const actor=await withContext('x',ctx=>Promise.resolve(ctx.actor),'500@s.whatsapp.net','400@g.us');expect(actor.role).toBe('member');
});
it('help filters owner tools, disabled modules, private scope and modelCallable',async()=>{
  const help=await command('bot ayuda','600@s.whatsapp.net');expect(help).not.toContain('control.emergency');expect(help).toContain('notes.create');
  await command('bot desactiva notas aquí');expect(await command('bot ayuda','600@s.whatsapp.net')).not.toContain('notes.create');
  await withContext('x',async ctx=>{const declarations=createRegistry().declarations(ctx);expect(declarations.some(d=>/control|memory_remember/.test(d.name))).toBe(false);});
});
it('model arguments cannot override identity, chat, permission or enable deterministic-only tools',async()=>{
  const registry=createRegistry();
  await withContext('x',async ctx=>{
    for(const injected of [{body:'x',actor:'owner'},{body:'x',chatId:'400@g.us'},{body:'x',permission:'config.global'}])expect((await registry.execute(ctx,'notes.create',injected,'model')).ok).toBe(false);
    expect((await registry.execute(ctx,'control.emergency',{},'model')).ok).toBe(false);
    expect((await registry.execute(ctx,'memory.remember',{body:'inventada'},'model')).ok).toBe(false);
  },'600@s.whatsapp.net');
  expect((await db.query('SELECT * FROM notes')).rowCount).toBe(0);
});
it('model sees only scoped tools and role, never actor/chat identifiers, and canonical output bypasses personality',async()=>{
  let sent='';
  const result=await withContext('botsky, guarda una nota',ctx=>route(ctx,{generate:async input=>{sent=JSON.stringify(input);return {text:'Lo cambié a #999',calls:[{name:'notes_create',args:{body:'reunión 18:45'}}],content:{}};}}));
  expect(sent).not.toContain('100@s.whatsapp.net');expect(sent).not.toContain('300@g.us');expect(result).toContain('Guardé la nota #');expect(result).not.toContain('#999');
  expect(compose({canonical:'$150 · 2026-10-18 · 08:00 · @100 · Ana #18',facts:{},intent:'tool'})).toBe('$150 · 2026-10-18 · 08:00 · @100 · Ana #18');
});
it('does not accept invented tool effects from free conversation output',async()=>{
  const result=await withContext('bot hola',ctx=>route(ctx,{generate:async()=>({text:'Guardé la nota #99.',calls:[],content:{}})}));
  expect(result).toContain('No ejecuté');
});
it('memory is explicit, bounded, sensitive-data filtered and hidden in groups',async()=>{
  expect(await command('bot acuérdate de que me gusta el ajedrez')).toContain('Guardé');
  expect(await command('bot qué sabes de mí')).toBe('Pídemelo por privado.');
  await command('bot activa memoria aquí','100@s.whatsapp.net','100@s.whatsapp.net');
  expect(await command('bot qué sabes de mí','100@s.whatsapp.net','100@s.whatsapp.net')).toContain('ajedrez');
  expect(await command('bot acuérdate de que mi contraseña es abc123')).toContain('No guardo');
  await command('bot olvídalo todo');expect((await db.query('SELECT * FROM user_memories')).rowCount).toBe(1);
  await command('sí');expect((await db.query('SELECT * FROM user_memories')).rowCount).toBe(0);
  for(const body of ['mi token abc','tarjeta 4111 1111 1111 1111','clave privada','AIzaFakeFakeFakeFakeFakeFakeFakeFake'])expect(sensitiveMemory(body)).toBe(true);
});
it('no-quota/disabled AI preserves shortcuts; ordinary conversations fail clearly',async()=>{
  expect(await command('bot hola')).toContain('no está configurada');expect(await command('bot ping')).toBe('pong');
  expect(await command('bot recordatorio en 2 minutos revisar horno')).toContain('Recordatorio #');
});
it('maintenance denies members and emergency persists until owner reactivation',async()=>{
  await command('bot mantenimiento on');expect(await command('bot ping','600@s.whatsapp.net')).toBe('Estoy en mantenimiento.');expect(await command('bot ping')).toBe('pong');
  await command('bot mantenimiento off');await command('bot apagado de emergencia');expect(await command('bot ping')).toBeUndefined();
  expect(await command('bot reactiva','600@s.whatsapp.net')).toBeUndefined();expect(await command('bot reactiva')).toBe('Botsky reactivado.');
});
it('reminders survive reconnect, enqueue once, stay queued until delivery, and catch up once',async()=>{
  await command('bot recordatorio en 2 minutos apagar horno');await db.query("UPDATE reminders SET due_at=now()-interval '10 minutes'");
  const fresh=createDb(url);await tickCore(fresh,config);await fresh.end();await tickCore(db,config);
  expect((await db.query("SELECT * FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rowCount).toBe(1);
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('queued');
  const mock=new MockEvolution();for(let i=0;i<5;i++){await db.query('UPDATE outbox SET sending_at=NULL');if(!await sendNext(db,mock,config))break;}
  await tickCore(db,config);expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('sent');
  const reminder=[...mock.deliveries.values()].find(d=>d.delivery.text.includes('interrupción'));expect(reminder).toBeDefined();
});
it('scheduled work pauses for emergency, disabled module and revoked private access',async()=>{
  await command('bot recordatorio en 2 minutos prueba');await db.query("UPDATE reminders SET due_at=now()-interval '1 minute'");
  await command('bot desactiva recordatorios aquí');await tickCore(db,config);expect((await db.query("SELECT * FROM reminders WHERE status='pending'")).rowCount).toBe(1);
  await command('bot activa recordatorios aquí');await command('bot apagado de emergencia');await tickCore(db,config);expect((await db.query("SELECT * FROM reminders WHERE status='queued'")).rowCount).toBe(0);
});
it('confirmation hash is stable over key order and binds action/arguments',()=>{
  expect(argumentHash('x',{a:1,b:2})).toBe(argumentHash('x',{b:2,a:1}));expect(argumentHash('x',{a:1})).not.toBe(argumentHash('y',{a:1}));
});
it('expired memberships lose admin and private autoapproval without losing a manual grant',async()=>{
  await db.query("UPDATE group_memberships SET last_seen_at=now()-interval '6 minutes'");
  expect(await command('ping','500@s.whatsapp.net','500@s.whatsapp.net')).toBeUndefined();
  await db.query("UPDATE users SET private_ok_manual=true WHERE id='500@s.whatsapp.net'");
  expect(await command('ping','500@s.whatsapp.net','500@s.whatsapp.net')).toBe('pong');
  const actor=await withContext('x',ctx=>Promise.resolve(ctx.actor),'500@s.whatsapp.net');expect(actor.role).toBe('member');
});
it('unresolved owner-looking LID never acquires owner privileges',async()=>{
  await withContext('x',async ctx=>{const actor=await actorFor(ctx.c,{...ctx.msg,senderId:'100@lid'}, {...config,OWNER_JIDS:['100@lid']});expect(actor.role).toBe('member');});
});
it('sensitive tools only authorize owner/admin in their real scope',()=>{
  const member:Actor={id:'600@s.whatsapp.net',role:'member'};const admin:Actor={...member,role:'group_admin'};
  const chat:Chat={id:'300@g.us',isGroup:true,enabled:true,settings:{}};
  expect(permitted(member,chat,'chat.use')).toBe(true);expect(permitted(member,chat,'notes.manage_shared')).toBe(false);expect(permitted(admin,chat,'notes.manage_shared')).toBe(true);expect(permitted(admin,{...chat,isGroup:false},'chat.configure')).toBe(false);
  expect(permitted(admin,chat,'infra.minecraft')).toBe(false);expect(permitted(admin,{...chat,enabled:false},'chat.use')).toBe(false);
});
it('selection expiry uses the DB clock and cannot be extended by an unrelated message',async()=>{
  await command('bot recuérdame estudiar');await db.query("UPDATE sessions SET expires_at=now()-interval '1 second'");
  await withContext('x',async ctx=>{expect(await activeSession(ctx.c,ctx.actor.id,ctx.chat.id)).toBeUndefined();});
});
it('refuses more than three proposed actions before any mutation',async()=>{
  const generated=vi.fn(async()=>({text:'',calls:Array.from({length:4},()=>({name:'notes_create',args:{body:'x'}})),content:{}}));
  const result=await withContext('bot haz varias',ctx=>route(ctx,{generate:generated}));expect(result).toContain('demasiadas');expect((await db.query('SELECT * FROM notes')).rowCount).toBe(0);
});
it('unrelated group messages do not consume a clarification session',async()=>{
  await command('bot recuérdame estudiar');
  expect(await command('somos 8 personas hoy')).toBeUndefined();
  expect((await db.query("SELECT * FROM sessions WHERE status='active'")).rowCount).toBe(1);
});
it('private modules are available to an eligible member without an owner activation',async()=>{
  expect(await command('nota guarda privada','500@s.whatsapp.net','500@s.whatsapp.net')).toContain('Guardé');
  await db.query("UPDATE group_memberships SET active=false WHERE user_id='500@s.whatsapp.net'");
  expect(await command('notas','500@s.whatsapp.net','500@s.whatsapp.net')).toBeUndefined();
});
it('recurring delivery advances once after confirmation and an uncertain delivery never advances',async()=>{
  const due=new Date(Date.now()+3_600_000);
  const {DateTime}=await import('luxon');const local=DateTime.fromJSDate(due,{zone:config.TZ_DEFAULT});
  await withContext('bot recordatorio',ctx=>createRegistry().execute(ctx,'reminders.create',{body:'diario',dueAt:local.toISO(),timezone:config.TZ_DEFAULT,recurrence:{kind:'daily',hour:local.hour,minute:local.minute}}));
  await db.query("UPDATE reminders SET due_at=now()-interval '2 days'");await tickCore(db,config);
  await db.query("UPDATE outbox SET status='uncertain' WHERE dedupe_key LIKE 'reminder:%'");await tickCore(db,config);
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('queued');
  await db.query("UPDATE outbox SET status='sent',sent_at=now() WHERE dedupe_key LIKE 'reminder:%'");await tickCore(db,config);await tickCore(db,config);
  const row=(await db.query<{status:string;due_at:Date}>('SELECT status,due_at FROM reminders')).rows[0]!;
  expect(row.status).toBe('pending');expect(row.due_at.getTime()).toBeGreaterThan(Date.now());
  expect((await db.query("SELECT * FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rowCount).toBe(1);
});
it('private scheduled reminders pause when their owner leaves all enabled groups',async()=>{
  await command('recordatorio en 2 minutos privado','500@s.whatsapp.net','500@s.whatsapp.net');await db.query("UPDATE reminders SET due_at=now()-interval '1 minute'");
  await db.query("UPDATE group_memberships SET active=false WHERE user_id='500@s.whatsapp.net'");await tickCore(db,config);
  expect((await db.query("SELECT * FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rowCount).toBe(0);
});
it('memory limit rejects the thirty-first opt-in record',async()=>{
  await db.query("INSERT INTO user_memories(user_id,body) SELECT '100@s.whatsapp.net','recuerdo '||n FROM generate_series(1,30) n");
  expect(await command('bot acuérdate de que prefiero café')).toContain('llena');
  expect((await db.query('SELECT * FROM user_memories')).rowCount).toBe(30);
});

it('does not invent reminder content when the user only provides a relative date',async()=>{
  expect(await command('haz un recordatorio para dentro de dos minutos botsky')).toBe('¿Qué quieres que te recuerde?');
  expect((await db.query('SELECT * FROM reminders')).rowCount).toBe(0);
  expect(await command('revisar el horno','600@s.whatsapp.net')).toBeUndefined();
  expect(await command('revisar el horno')).toContain('revisar el horno');
  expect((await db.query('SELECT body FROM reminders')).rows).toEqual([{body:'revisar el horno'}]);
  expect((await db.query('SELECT * FROM llm_usage')).rowCount).toBe(0);
});
it('asks for missing content even when Gemini proposes a date without a body',async()=>{
  const date=new Date(Date.now()+120_000).toISOString();
  await withContext('bot programa algo',ctx=>createRegistry().execute(ctx,'reminders.create',{dueAt:date,timezone:'UTC'},'model'));
  expect((await db.query('SELECT * FROM reminders')).rowCount).toBe(0);
  expect((await db.query("SELECT accepted_inputs FROM sessions WHERE status='active'")).rows[0]?.accepted_inputs).toContain('contenido');
});
it('reports local usage limits, remote quota and timeouts as distinct causes',()=>{
  expect(llmError(new LlmUnavailable('local_limit','tokens'))).toContain('límite de IA de Botsky');
  expect(llmError(new LlmUnavailable('timeout'))).toContain('tardó demasiado');
  expect(llmError(new LlmUnavailable('quota'))).toContain('cuota');
});
it('a delayed answer to a missing-content prompt asks for a new date instead of inventing one',async()=>{
  await command('bot recordatorio en dos minutos');
  await db.query("UPDATE sessions SET state=jsonb_set(state,'{args,dueAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE status='active'");
  expect(await command('entregar el proyecto')).toBe('¿Cuándo quieres que te lo recuerde?');
  expect((await db.query('SELECT * FROM reminders')).rowCount).toBe(0);
  expect(await command('Mañana a las 8 am')).toContain('entregar el proyecto');
});
it('owner diagnostics expose local policy and token reservations without exposing credentials',async()=>{
  const output=await command('bot diag cuota');expect(output).toContain('Límites de Botsky:');expect(output).toContain('incluye reservas pendientes');
  expect(output).not.toContain(config.EVOLUTION_APIKEY);
  expect(await command('bot diag cuota','600@s.whatsapp.net')).toBe('No.');
});
it('a reminder clarification preserves its explicit IANA timezone instead of the chat default',async()=>{
  await withContext('bot programa',ctx=>createRegistry().execute(ctx,'reminders.create',{dueAt:new Date(Date.now()+120_000).toISOString(),timezone:'UTC'}));
  await db.query("UPDATE sessions SET state=jsonb_set(state,'{args,dueAt}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE status='active'");
  expect(await command('revisar el horno')).toBe('¿Cuándo quieres que te lo recuerde?');
  expect(await command('Mañana a las 8 am')).toContain('08:00 (UTC)');
  const row=(await db.query<{timezone:string;due_at:Date}>('SELECT timezone,due_at FROM reminders')).rows[0]!;
  expect(row.timezone).toBe('UTC');expect(row.due_at.getUTCHours()).toBe(8);
});
it('image follow-ups reuse only the quoted image already received in this chat',async()=>{
  const photo=msg('bot foto');photo.id='manual-image-origin';photo.attachments=[{kind:'image',ref:'manual-image-origin:image',mime:'image/jpeg'}];
  await receive(db,config,photo);
  const fixture=JSON.parse(readFileSync('tests/fixtures/image-quote.json','utf8'));
  const {normalizeData}=await import('../src/wa/normalize.js');const event=normalizeData(fixture);if(event?.kind!=='message')throw new Error('Missing quote');
  const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({mimetype:'image/jpeg',base64:Buffer.from('same image').toString('base64')}));
  let actual='';
  try{
    const result=await withContext('bot color',ctx=>route({...ctx,msg:{...ctx.msg,quoted:event.message.quoted!}},{generate:async input=>{actual=JSON.stringify(input.contents);return {text:'Blanco y marrón.',calls:[],content:{}};}}));
    expect(result).toBe('Blanco y marrón.');expect(actual).toContain('inlineData');
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body)).message.key).toMatchObject({id:'manual-image-origin',remoteJid:'300@g.us'});
  }finally{http.mockRestore();}
});
it('a quoted image in another chat or without an inbox record is unavailable before calling providers',async()=>{
  const photo=msg('bot foto','100@s.whatsapp.net','400@g.us');photo.id='other-image';photo.attachments=[{kind:'image',ref:'other-image:image'}];
  await receive(db,{...config,LAB_CHAT_ID:'400@g.us'},photo);
  const generated=vi.fn(async()=>({text:'inventado',calls:[],content:{}}));const http=vi.spyOn(globalThis,'fetch');
  try{for(const id of ['other-image','unknown-image']){
    const output=await withContext('bot color',ctx=>route({...ctx,msg:{...ctx.msg,quoted:{id,fromBot:false,attachments:[{kind:'image',ref:`${id}:image`}]}}},{generate:generated}));
    expect(output).toContain('Reenvíala');
  }expect(generated).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();}finally{http.mockRestore();}
});
it('complete web searches consume no Gemini calls and remove the trailing invocation only from the query',async()=>{
  const generated=vi.fn(async()=>({text:'',calls:[],content:{}}));const searched:string[]=[];
  const output=await withContext('busca fecha nueva temporada de Re:Zero botsky',ctx=>route({...ctx,search:async query=>{searched.push(query);return 'Fuentes exactas #18';}},{generate:generated}));
  expect(searched).toEqual(['fecha nueva temporada de Re:Zero']);expect(generated).not.toHaveBeenCalled();expect(output).toBe('Fuentes exactas #18');
});
it('contextual searches retain the prior search goal and image topic in scoped input, with only web tools allowed',async()=>{
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text) VALUES('300@g.us','100@s.whatsapp.net','user','oye botsky quien esta en la foto'),('300@g.us','100@s.whatsapp.net','bot','Es Emilia de Re:Zero con un traje de Puck.'),('300@g.us','100@s.whatsapp.net','user','busca cuando sale la nueva temporada botsky'),('300@g.us','100@s.whatsapp.net','bot','Fuentes anteriores irrelevantes')");
  let sent='';const searched:string[]=[];
  const output=await withContext('pero busca de la de la foto botsky',ctx=>route({...ctx,search:async query=>{searched.push(query);return 'Respuesta canónica con fuentes';}},{generate:async input=>{
    sent=JSON.stringify(input);expect(input.tools.map(t=>t.name)).toEqual(['web_search']);
    return {text:'Texto libre descartado',calls:[{name:'web_search',args:{query:'Re:Zero temporada 3 fecha estreno'}}],content:{}};
  }}));
  expect(sent).toContain('Re:Zero');expect(sent).toContain('previousSearchRequest');expect(sent).toContain('cuando sale la nueva temporada');
  expect(sent).not.toContain('100@s.whatsapp.net');expect(sent).not.toContain('300@g.us');
  expect(searched).toEqual(['Re:Zero nueva temporada fecha estreno']);expect(output).toBe('Respuesta canónica con fuentes');
});
it('a contextual query without a current scoped antecedent asks the topic before using either provider',async()=>{
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text,created_at) VALUES('400@g.us','100@s.whatsapp.net','bot','Tema de otro chat',now()),('300@g.us','600@s.whatsapp.net','bot','Tema de otro usuario',now()),('300@g.us','100@s.whatsapp.net','bot','Tema vencido',now()-interval '8 days')");
  const generated=vi.fn(async()=>({text:'',calls:[],content:{}}));const search=vi.fn(async()=> 'No debe buscar');
  const output=await withContext('busca cuando sale la nueva temporada botsky',ctx=>route({...ctx,search},{generate:generated}));
  expect(output).toContain('¿Sobre qué serie o tema');expect(generated).not.toHaveBeenCalled();expect(search).not.toHaveBeenCalled();
});
it('contextual search rejects unsolicited writes even when the model proposes a registered tool',async()=>{
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text) VALUES('300@g.us','100@s.whatsapp.net','bot','La serie mencionada es Re:Zero')");
  const output=await withContext('busca cuando sale la nueva temporada botsky',ctx=>route(ctx,{generate:async()=>({text:'',calls:[{name:'notes_create',args:{body:'No autorizado por la búsqueda'}}],content:{}})}));
  expect(output).toBe('No.');expect((await db.query('SELECT * FROM notes')).rowCount).toBe(0);
});
it('contextual search respects a disabled web module before Gemini and does not claim a search from free text',async()=>{
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text) VALUES('300@g.us','100@s.whatsapp.net','bot','La serie mencionada es Re:Zero')");
  const generated=vi.fn(async()=>({text:'Se estrena mañana, lo encontré.',calls:[],content:{}}));
  expect(await withContext('bot busca esa serie',ctx=>route(ctx,{generate:generated}))).toContain('¿Sobre qué serie o tema');
  await command('bot desactiva web aquí');generated.mockClear();
  expect(await withContext('bot busca esa serie',ctx=>route(ctx,{generate:generated}))).toContain('desactivada');expect(generated).not.toHaveBeenCalled();
});

it('a breed follow-up without a quote sends the latest own image, retaining uncertainty and the subsequent joke',async()=>{
  for(const id of ['older-dog','latest-dog']){
    const photo=msg('bot describe esta imagen');photo.id=id;photo.attachments=[{kind:'image',ref:`${id}:image`}];
    await receive(db,config,photo);
  }
  const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({mimetype:'image/jpeg',base64:Buffer.from('latest image').toString('base64')}));
  const answer='Parece un pug por los pliegues, pero no puedo confirmar la raza en este meme editado. Hasta el perro sonríe mejor que tú.';
  try{
    const output=await withContext('que raza será bot?',ctx=>route(ctx,{generate:async input=>{
      expect(JSON.stringify(input.contents)).toContain('inlineData');
      return {text:answer,calls:[],content:{}};
    }}));
    expect(output).toBe(answer);
    expect(JSON.parse(String(http.mock.calls[0]?.[1]?.body)).message.key.id).toBe('latest-dog');
  }finally{http.mockRestore();}
});
it.each(['other actor','other chat','expired receipt','expired photo','future photo','failed input'])('a breed question rejects an image from %s before calling either provider',async kind=>{
  const photo=msg('bot foto',kind==='other actor'?'600@s.whatsapp.net':'100@s.whatsapp.net',kind==='other chat'?'400@g.us':'300@g.us');
  photo.id='unavailable-dog';photo.attachments=[{kind:'image',ref:'unavailable-dog:image'}];
  await receive(db,kind==='other chat'?{...config,LAB_CHAT_ID:'400@g.us'}:config,photo);
  if(kind==='expired receipt')await db.query("UPDATE inbox SET received_at=now()-interval '11 minutes'");
  if(kind==='expired photo' || kind==='future photo')await db.query("UPDATE inbox SET payload=jsonb_set(payload,'{ts}',to_jsonb((now()+$1::interval)::text))",[kind==='expired photo'?'-11 minutes':'1 minute']);
  if(kind==='failed input')await db.query("UPDATE inbox SET status='failed'");
  const generated=vi.fn(async()=>({text:'Es un pug puro, seguro.',calls:[],content:{}}));
  const http=vi.spyOn(globalThis,'fetch');
  try{
    expect(await withContext('que raza será bot?',ctx=>route(ctx,{generate:generated}))).toContain('Reenvíala');
    expect(generated).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();
  }finally{http.mockRestore();}
});
it('an explicit unknown image quote never falls back to a different recent image',async()=>{
  const photo=msg('bot foto');photo.id='recent-dog';photo.attachments=[{kind:'image',ref:'recent-dog:image'}];await receive(db,config,photo);
  const generated=vi.fn(async()=>({text:'inventado',calls:[],content:{}}));
  expect(await withContext('que raza será bot?',ctx=>route({...ctx,msg:{...ctx.msg,quoted:{id:'unknown',fromBot:false,attachments:[{kind:'image',ref:'unknown:image'}]}}},{generate:generated}))).toContain('Reenvíala');
  expect(generated).not.toHaveBeenCalled();
});
it('recent-image breed follow-ups respect the vision module before downloading or generating',async()=>{
  const photo=msg('bot foto');photo.id='disabled-dog';photo.attachments=[{kind:'image',ref:'disabled-dog:image'}];await receive(db,config,photo);
  await db.query("UPDATE inbox SET status='done'");
  await command('bot desactiva vision aquí');
  const generated=vi.fn(async()=>({text:'inventado',calls:[],content:{}}));const http=vi.spyOn(globalThis,'fetch');
  try{
    expect(await withContext('que raza será bot?',ctx=>route(ctx,{generate:generated}))).toContain('visión está desactivada');
    expect(generated).not.toHaveBeenCalled();expect(http).not.toHaveBeenCalled();
  }finally{http.mockRestore();}
});
it.each(['bot cuanto es 17 por 23?','bot de qué raza es Scooby Doo?'])('does not attach a recent photo to a self-contained question: %s',async text=>{
  const photo=msg('bot foto');photo.id='unrelated-dog';photo.attachments=[{kind:'image',ref:'unrelated-dog:image'}];await receive(db,config,photo);
  const http=vi.spyOn(globalThis,'fetch');
  try{
    await withContext(text,ctx=>route(ctx,{generate:async input=>{
      expect(JSON.stringify(input.contents)).not.toContain('inlineData');return {text:'Respuesta útil.',calls:[],content:{}};
    }}));
    expect(http).not.toHaveBeenCalled();
  }finally{http.mockRestore();}
});
it('retains a safe search goal when a canonical source URL is excluded from context',async()=>{
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text) VALUES('300@g.us','100@s.whatsapp.net','user','oye botsky quien esta en la foto'),('300@g.us','100@s.whatsapp.net','bot','Es Emilia de Re:Zero.')");
  const sources='Re:Zero nueva temporada\nhttps://example.com/una-ruta-publica-de-estreno-muy-larga-2026';
  expect(sensitiveMemory(sources)).toBe(true);
  await withContext('busca cuando sale la nueva temporada botsky',async ctx=>{
    const response=await route({...ctx,search:async()=>sources},{generate:async()=>({text:'',calls:[{name:'web_search',args:{query:'Re Zero nueva temporada fecha de estreno'}}],content:{}})});
    expect(response).toBe(sources);await rememberContext(ctx,response!);
  });
  const history=(await db.query<{role:string;text:string}>('SELECT role,text FROM context_msgs ORDER BY id')).rows;
  expect(history.at(-1)).toEqual({role:'user',text:'busca cuando sale la nueva temporada botsky'});
  expect(history.some(row=>row.text===sources)).toBe(false);
  const searched:string[]=[];
  const output=await withContext('pero busca de la de la foto botsky',ctx=>route({...ctx,search:async query=>{searched.push(query);return sources;}},{generate:async input=>{
    expect(JSON.stringify(input.contents)).toContain('previousSearchRequest');
    expect(JSON.stringify(input.contents)).toContain('cuando sale la nueva temporada');
    const contents=input.contents as {role:string;parts:unknown[]}[];
    expect(contents.map(turn=>turn.role)).toEqual(['user','model','user']);
    expect(contents.at(-1)?.parts).toHaveLength(2);
    return {text:'',calls:[{name:'web_search',args:{query:'Re Zero temporada 3 fecha de estreno'}}],content:{}};
  }}));
  expect(searched).toEqual(['Re Zero nueva temporada fecha de estreno']);expect(output).toBe(sources);
});
it('keeps sensitive user turns and filtered responses out of context without discarding other safe requests',async()=>{
  await withContext('bot mi contraseña es ejemplo-no-real',ctx=>rememberContext(ctx,'No.'));
  expect((await db.query('SELECT * FROM context_msgs')).rowCount).toBe(0);
  await withContext('bot busca noticias',ctx=>rememberContext(ctx,'El token es ejemplo-no-real'));
  expect((await db.query('SELECT role,text FROM context_msgs')).rows).toEqual([{role:'user',text:'bot busca noticias'}]);
});

it('diag.cuota reports configured protection and pool metrics without credentials',async()=>{
  const pooled={...config,GEMINI_API_KEYS:['fixture-one','fixture-two','fixture-three'],LLM_LOCAL_GLOBAL_RPM:19,LLM_LOCAL_USER_RPM:0,LLM_LOCAL_DAILY_LIMIT:0};
  const pool=geminiKeyPool(pooled);
  await pool.run(async(_,index)=>{if(index===1)throw new GeminiAttemptError('quota',429,120000);return 'ok';});
  await pool.run(async(_,index)=>{if(index===3)throw new GeminiAttemptError('provider',401);return 'ok';});
  const output=await withContext('bot diag cuota',ctx=>route({...ctx,config:pooled}));
  expect(output).toContain('19 llamadas/min');expect(output).toContain('sin límite local');
  expect(output).toContain('3 configuradas / 2 saludables / 1 disponibles / 1 cooldown');
  expect(output).toContain('failovers: 2');expect(output).toContain('rate limits: 1');expect(output).toContain('gemini-key-3');
  for(const secret of [...pooled.GEMINI_API_KEYS,pooled.EVOLUTION_APIKEY])expect(output).not.toContain(secret);
});
