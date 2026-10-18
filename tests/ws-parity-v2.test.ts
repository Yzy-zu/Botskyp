import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimMedia,processMedia } from '../src/modules/media/worker.js';
import { DateTime } from 'luxon';
import { beforeAll,beforeEach,afterAll,afterEach,it,expect,vi } from 'vitest';
import { db,config,owner,member,chat,initialize,reset,context,backing,png,pdf,count } from './r4-harness.js';
import { route } from '../src/core/router.js';
import { Gemini,type Llm,type LlmReply,type LlmInput } from '../src/core/llm.js';
import { buildTurnContextV2 } from '../src/core/context-v2.js';
import { rememberContextResultV2 } from '../src/core/context-results-v2.js';
import { confirmationInputV2 } from '../src/core/session-input-v2.js';
import { openClarificationV2,readSessionV2 } from '../src/core/sessions-v2.js';
import { transaction } from '../src/db/client.js';
import { explicitClock,resolveSemanticTime } from '../src/modules/reminders/semantic-time.js';
import { ambiguousTime } from '../src/modules/reminders/time.js';
import { receive,processNext } from '../src/core/inbox.js';
import { explicitWebRequest } from '../src/core/capability-truth-v2.js';
import { parityConversation } from './fixtures/v1.1/ws-parity-1.js';
import * as minecraft from '../src/modules/minecraft/client.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg } from '../src/wa/types.js';
const call=(name:string,args:unknown={}):LlmReply=>({text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:name.replaceAll('.','_'),args}}]}});
const say=(text:string):LlmReply=>({text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'conversation',text,effects:[]})}]}});
function scripted(...outputs:(LlmReply|((input:LlmInput)=>LlmReply))[]){return {generate:vi.fn<Llm['generate']>(async input=>{const value=outputs.shift();if(!value)throw new Error('Unexpected provider call');return typeof value==='function'?value(input):value;})};}
async function turn(text:string,llm:Llm=scripted(),setup?:(ctx:ToolCtx)=>Promise<void>,input:Partial<Msg>={}){
  return context({text,...input},async ctx=>{await setup?.(ctx);return {text:await route(ctx,llm),turnId:ctx.turnId};});
}
beforeAll(initialize);
beforeEach(async()=>{
  await reset();
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,1000)',[owner]);
  vi.spyOn(minecraft,'callMinecraft').mockImplementation(async(request,id)=>({v:1,id:id ?? 'mock',ok:true,action:request.action,code:'ok',data:{online:true,running:true,players:2,maxPlayers:10,names:['Alex','Steve'],cpuPercent:5,memoryBytes:1000}}));
});
afterEach(()=>vi.restoreAllMocks());afterAll(()=>db.end());
it.each(parityConversation)('Canary fixture: $text → $tool through Policy',async fixture=>{
  const llm=scripted(input=>{expect(input.tools.map(t=>t.name)).toContain(fixture.tool.replaceAll('.','_'));return call(fixture.tool,fixture.args);});
  const output=await turn(fixture.text,llm);
  expect(output.text).not.toMatch(/p[aá]same.*IP|no.*permisos|no la tengo conectada/iu);
  expect((await db.query('SELECT tool_name,status FROM tool_executions WHERE turn_id=$1',[output.turnId])).rows).toEqual([{tool_name:fixture.tool,status:'ok'}]);
});
it.each(['minecraft.status','minecraft.players','xp.balance'] as const)('capability truth retries %s once and executes a real tool',async name=>{
  const text=name==='xp.balance'?'cuántos puntos tengo?':name==='minecraft.players'?'hay alguien en el maicra?':'está prendido el maicra?';
  const llm=scripted(say('No tengo acceso, pásame la IP.'),input=>{
    expect(input.requireFunctionCall).toBe(true);
    expect(JSON.stringify(input.contents)).toContain('The requested capability is available in Botsky');
    expect(input.system).not.toMatch(/100\.\d+\.|\/home\/|MINECRAFT_/u);
    return call(name);
  });
  const output=await turn(text,llm);expect(output.text).not.toMatch(/pásame/iu);expect(llm.generate).toHaveBeenCalledTimes(2);
  expect((await db.query('SELECT tool_name FROM tool_executions WHERE turn_id=$1',[output.turnId])).rows).toEqual([{tool_name:name}]);
});
it('bounds capability recovery and never returns a repeated invented IP requirement',async()=>{
  const llm=scripted(say('Pásame la IP.'),say('No tengo acceso, necesito IP.'));
  expect((await turn('está activo el maicra?',llm)).text).toContain('no llegó a ejecutarse');
  expect(llm.generate).toHaveBeenCalledTimes(2);expect(await count('tool_executions')).toBe(0);
});
it('does not recover missing/disabled capabilities or infer a privileged mutation',async()=>{
  const llm=scripted(say('No puedo hacerlo.'));
  await context({text:'está activo el maicra?'},ctx=>route({...ctx,config:{...ctx.config,MINECRAFT_ENABLED:false}},llm));
  expect(llm.generate).toHaveBeenCalledOnce();
  const mutation=scripted(say('No puedo hacerlo.'));
  await turn('reinicia el maicra',mutation);expect(mutation.generate).toHaveBeenCalledOnce();expect(await count('minecraft_operations')).toBe(0);
});
it('Minecraft aliases never grant a member infrastructure permissions',async()=>{
  expect((await turn('reinicia el maicra',scripted(call('minecraft.restart')),undefined,{senderId:member})).text).toContain('dueño');
  expect(await count('minecraft_operations')).toBe(0);expect(minecraft.callMinecraft).not.toHaveBeenCalled();
});
it('explicit web search overrules a joke and calls the real search tool',async()=>{
  const search=vi.fn(async()=> 'Fuente\nNo hay evidencia de ese parentesco.\nhttps://example.org/evidencia');
  const llm=scripted(say('No hace falta buscar, es tu tío.'),call('web.search',{query:'Elon Musk parentesco'}),say('No encontré evidencia. Fuente: https://example.org/evidencia'));
  const output=await context({text:'busca en la web si elon musk es mi tío botsky'},ctx=>route({...ctx,search},llm));
  expect(output).toContain('No encontré evidencia');expect(search).toHaveBeenCalledOnce();
  expect((await db.query('SELECT tool_name,status FROM tool_executions')).rows).toEqual([{tool_name:'web.search',status:'ok'}]);
});
it.each(['búscalo en internet','investígalo en internet','busca esto','checa en la web'])('recognizes explicit search: %s',text=>expect(explicitWebRequest(text)).toBe(true));
it.each(['busca videos de gatos','busca música de Mozart','cuánto es 2+2'])('does not force web for %s',text=>expect(explicitWebRequest(text)).toBe(false));
it.each(['8pm','8 pm','20:00','8 de la noche'])('explicit clock %s resolves to 20:00 without AM/PM clarification',text=>{
  const clock=explicitClock(text)!;expect(clock).toBeDefined();
  const result=resolveSemanticTime({kind:'tomorrow',...clock},new Date('2026-10-17T18:00:00Z'));
  expect(result.status).toBe('ok');if(result.status==='ok')expect(DateTime.fromJSDate(result.dueAt,{zone:'America/Mexico_City'}).hour).toBe(20);
  expect(ambiguousTime(`a las ${text}`)).toBe(false);
});
it('exact Canary reminder: 8pm → mañana → cancelalo preserves tomorrow and cancels the newly created reminder',async()=>{
  const initial=await turn('guarda un recordatorio para las 8pm, di q estoy tonto',scripted(call('reminders.create',{body:'estoy tonto',time:{kind:'today',hour:8}})));
  expect(initial.text).toContain('hoy o mañana');expect(initial.text).not.toContain('mañana o de la noche');expect(await count('reminders')).toBe(0);
  const second=await turn('mañana');expect(second.text).toContain('recordaré');
  const row=(await db.query<{due_at:Date;status:string}>('SELECT due_at,status FROM reminders')).rows[0]!;
  expect(DateTime.fromJSDate(row.due_at,{zone:'America/Mexico_City'}).toFormat('yyyy-MM-dd HH:mm')).toBe(DateTime.now().setZone('America/Mexico_City').plus({days:1}).toFormat('yyyy-MM-dd')+' 20:00');
  expect((await turn('cancelalo')).text).toContain('cancelé');expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('cancelled');
});
it('partial slots accept tomorrow before the requested period and keep it after de la noche',async()=>{
  await turn('guarda un recordatorio a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'today',hour:8}})));
  expect((await turn('mañana')).text).toContain('mañana o de la noche');expect(await count('reminders')).toBe(0);
  expect((await turn('De la noche')).text).toContain('recordaré');
  expect((await db.query("SELECT to_char(due_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') due FROM reminders")).rows[0]?.due).toBe(DateTime.now().setZone('America/Mexico_City').plus({days:1}).toFormat('yyyy-MM-dd')+' 20:00');
});
it.each(['mañana','el viernes','a las 9','mejor a las 10','sí pero mejor a las 9'])('merges unambiguous temporal fragment %s without consuming a new intent',async text=>{
  await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8}})));
  const result=await turn(text);expect(result.text).toBeTruthy();expect(result.text).not.toContain('No pude procesar');
  if(text.includes('9') || text.includes('10')){
    const s=await context({},ctx=>readSessionV2(ctx.c,owner,chat));expect((s?.partial_args.time as {hour:number}).hour).toBe(text.includes('10')?10:9);
  }
});
it('a new XP intent escapes a pending reminder slot',async()=>{
  await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8}})));
  expect((await turn('cuánto xp tengo?',scripted(call('xp.balance')))).text).toContain('XP');expect(await count('reminders')).toBe(0);
});
it.each(['cancela','cancelalo','cancélalo','nel','mejor no','ya no','olvídalo','déjalo'])('cancels a pending session with %s',async text=>{
  await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8}})));
  expect((await turn(text)).text).toContain('cancelado');expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('cancelled');expect(await count('reminders')).toBe(0);
});
it('recent cancellation is actor/chat scoped and needs a recent receipt',async()=>{
  await turn('recuérdame en una hora estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'relative',amount:1,unit:'hour'}})));
  await turn('cancelalo',scripted(say('¿Cuál recordatorio?')),undefined,{senderId:member});
  await turn('cancelalo',scripted(say('¿Cuál recordatorio?')),undefined,{chatId:'400@g.us'});
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('pending');
});
it('inbox activates tomorrow and immediate cancellation without callword, with dedupe',async()=>{
  const enabled={...config,GEMINI_API_KEY:'mock-key',GEMINI_FREE_TIER_CONFIRMED:true};
  vi.spyOn(Gemini.prototype,'generate').mockResolvedValue(call('reminders.create',{body:'estudiar',time:{kind:'today',hour:8}}));
  for(const text of ['botsky guarda un recordatorio para las 8pm, di estudiar','mañana','cancelalo']){
    const msg:Msg={id:randomUUID(),chatId:chat,senderId:owner,isGroup:true,fromMe:false,ts:new Date(),text,mentions:[],attachments:[]};
    await receive(db,enabled,msg);await processNext(db,enabled);
    expect(await receive(db,enabled,msg)).toBe('duplicate');
  }
  expect((await db.query('SELECT status FROM reminders')).rows).toEqual([{status:'cancelled'}]);expect(Gemini.prototype.generate).toHaveBeenCalledOnce();
});
it('si botsky confirms the existing preview once; changed permissions still prevent Nuclear',async()=>{
  expect(confirmationInputV2('si botsky')).toBe('confirm');expect(confirmationInputV2('sí pero mejor a las 9')).toBe('not_consumed');
  await turn('activa la nuclear botsky',scripted(call('bulk.nuclear',{text:'hola'})));
  expect(await count('bulk_ops')).toBe(0);
  await db.query(`UPDATE chats SET settings='{"modules":{"messaging":false}}' WHERE id=$1`,[chat]);
  expect((await turn('si botsky')).text).toContain('apagado');expect(await count('bulk_ops')).toBe(0);
  expect(await count('tool_confirmations_v2')).toBe(1);
});
it.each(['hazla sticker botsky','oye cuanta xp tengo botsky','el server del maicra esta activo botsky?'])('old image/OCR semantics never bleed into %s; A_LAST survives',async text=>{
  await context({text:'captura'},async ctx=>{await backing(ctx,{mime:'image/png',bytes:png,filename:'CICLO_PRIVADO_ANTERIOR.png'});await rememberContextResultV2(ctx.c,'v1_1',{chatId:chat,actorId:owner,key:'old',kind:'ocr',text:'CICLO_PRIVADO_ANTERIOR'});});
  await db.query("INSERT INTO context_msgs(chat_id,user_id,role,text) VALUES($1,$2,'bot','CICLO_PRIVADO_ANTERIOR')",[chat,owner]);
  const llm=scripted(input=>{const all=JSON.stringify(input.contents);expect(all).not.toContain('CICLO_PRIVADO_ANTERIOR');expect(all).not.toContain(png.toString('base64'));return text.includes('sticker')?call('media.process',{operation:'sticker'}):text.includes('xp')?call('xp.balance'):call('minecraft.status');});
  expect((await turn(text,llm)).text ?? '').not.toContain('CICLO_PRIVADO_ANTERIOR');expect(await count('chat_artifacts')).toBe(1);
});
it('current image wins over an explicit reply and old images; only one is sent',async()=>{
  let old='';await context({},async ctx=>{old=ctx.msg.id;await backing(ctx,{mime:'image/png',bytes:png});});
  const newer=Buffer.concat([png,Buffer.from('new')]);
  await turn('qué dice ahí?',scripted(input=>{const parts=(input.contents[0] as {parts:{inlineData?:unknown}[]}).parts;expect(parts.filter(p=>p.inlineData)).toHaveLength(1);expect(JSON.stringify(parts)).toContain(newer.toString('base64'));return say('Veo la imagen nueva.');}),ctx=>backing(ctx,{mime:'image/png',bytes:newer}).then(()=>undefined),{quoted:{id:old,fromBot:false}});
});
it('clear image follow-up still reads the last image and explicit semantic results',async()=>{
  await context({},async ctx=>{await backing(ctx,{mime:'image/png',bytes:png});await rememberContextResultV2(ctx.c,'v1_1',{chatId:chat,actorId:owner,key:'read',kind:'ocr',text:'Texto de esa imagen'});});
  await turn('qué dice ahí?',scripted(input=>{expect(JSON.stringify(input.contents)).toContain(png.toString('base64'));expect(JSON.stringify(input.contents)).toContain('Texto de esa imagen');return say('Texto de esa imagen');}));
});
it('media follow-up reports only the relevant failed PDF even after newer unrelated jobs',async()=>{
  await db.query(`INSERT INTO jobs(kind,chat_id,owner_id,status,payload,error) VALUES('media',$1,$2,'failed','{"operation":"office_pdf"}','process_timeout'),('media',$1,$2,'done','{"operation":"sticker"}',NULL)`,[chat,owner]);
  const result=await turn('no me enviaste mi pdf botsky');expect(result.text).toContain('conversión a PDF falló');expect(result.text).toContain('tardó demasiado');expect(result.text).not.toMatch(/Archivo [1-5]|sticker|confirmado/iu);
});
it('media history lists multiple operations only on explicit request and never claims an unconfirmed delivery',async()=>{
  await db.query(`INSERT INTO jobs(kind,chat_id,owner_id,status,payload) VALUES('media',$1,$2,'done','{"operation":"office_pdf"}'),('media',$1,$2,'running','{"operation":"sticker"}')`,[chat,owner]);
  const one=await turn('no me llegó botsky');expect(one.text?.split('\n')).toHaveLength(1);
  const history=await turn('mis trabajos botsky',scripted(call('media.status')));expect(history.text?.split('\n')).toHaveLength(2);expect(history.text).toContain('envío sigue pendiente');
});
async function startCollection(operation:'images_pdf'|'pdf_merge'='images_pdf'){
  return turn(operation==='images_pdf'?'hazme un pdf con estas fotos botsky':'une mis pdf botsky',scripted(call('media.collect',{operation})));
}
async function addFile(mime='image/png',bytes=png,id=randomUUID()){
  return turn('',scripted(),ctx=>backing(ctx,{mime,bytes}).then(()=>undefined),{id,attachments:[{kind:mime.startsWith('image/')?'image':'document',ref:`${id}:file`,mime}]});
}
it.each(['ya','termina','hazlo'])('media.collect: two images → %s → one job, with scoped retained inputs',async finish=>{
  expect((await startCollection()).text).toContain('Voy a reunir');expect((await addFile()).text).toContain('1 fotos');expect((await addFile()).text).toContain('2 fotos');
  await turn(finish);expect(await count('jobs')).toBe(1);
  const job=(await db.query('SELECT payload FROM jobs')).rows[0]!.payload;expect(job.operation).toBe('images_pdf');expect(job.sources).toHaveLength(2);expect(new Set(job.sources.map((s:{storedId:string})=>s.storedId)).size).toBe(2);
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('done');
});
it('media.collect dedupes repeated input, rejects incompatible files and permits a new intent',async()=>{
  await startCollection();const id=randomUUID();await addFile('image/png',png,id);await turn('',scripted(),undefined,{id,attachments:[{kind:'image',ref:`${id}:file`,mime:'image/png'}]});
  expect((await addFile('application/pdf',pdf)).text).toContain('no es una foto');
  expect((await turn('cuánto XP tengo?',scripted(call('xp.balance')))).text).toContain('XP');
  await turn('terminar');expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload.sources).toHaveLength(1);
});
it('media.collect merges two PDFs using the same jobs',async()=>{
  await startCollection('pdf_merge');await addFile('application/pdf',pdf);expect((await turn('terminar')).text).toContain('al menos dos');await addFile('application/pdf',pdf);await turn('terminar');
  expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload).toMatchObject({operation:'pdf_merge',sources:[expect.any(Object),expect.any(Object)]});
});
it.each(['cancel','expire','module','actor','chat','backing'] as const)('media.collect preserves %s boundaries',async change=>{
  await startCollection();await addFile();
  if(change==='cancel')await turn('mejor no');
  if(change==='expire')await db.query("UPDATE sessions_v2 SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second'");
  if(change==='module')await db.query(`UPDATE chats SET settings='{"modules":{"media":false}}' WHERE id=$1`,[chat]);
  if(change==='backing')await db.query('UPDATE media_attachments SET data=NULL');
  await turn('terminar',scripted(say('No hay colección disponible.')),undefined,change==='actor'?{senderId:member}:change==='chat'?{chatId:'400@g.us'}:{});
  expect(await count('jobs')).toBe(0);
});
it('a pending reminder still updates slots across a transaction without creating another session',async()=>{
  await transaction(db,c=>openClarificationV2(c,'v1_1',{actorId:owner,chatId:chat,pendingTool:'reminders.create',partialArgs:{body:'estudiar',time:{kind:'date',date:'2026-10-20',hour:8}},missingSlots:[{kind:'am_pm',hour:8}],prompt:'¿Mañana o noche?',code:'AMBIGUOUS_HOUR',now:new Date()}));
  await turn('el viernes');await turn('mejor a las 10');
  await context({},async ctx=>{const s=await readSessionV2(ctx.c,owner,chat);expect((s?.partial_args.time as {hour:number}).hour).toBe(10);const snapshot=await buildTurnContextV2(ctx);expect(snapshot.envelope.REFERENCE_DATA.activeSession).toBeDefined();});
  expect(await count('sessions_v2')).toBe(1);
});
it('changing the hour while date is missing preserves the missing date slot',async()=>{
  await turn('guarda un recordatorio para las 8pm, di estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'today',hour:8}})));
  expect((await turn('sí pero mejor a las 9')).text).toContain('hoy o mañana');expect(await count('reminders')).toBe(0);
  await turn('mañana');expect((await db.query("SELECT to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') clock FROM reminders")).rows[0]?.clock).toBe('21:00');
});
it('a model-supplied period cannot bypass ambiguity in the authenticated user message',async()=>{
  const result=await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8,meridiem:'pm'}})));
  expect(result.text).toContain('mañana o de la noche');expect(await count('reminders')).toBe(0);
  expect((await turn('de la mañana')).text).toContain('recordaré');
  expect((await db.query("SELECT to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') clock FROM reminders")).rows[0]?.clock).toBe('08:00');
});
it('a completed unrelated tool prevents implicit cancellation of an older reminder',async()=>{
  await turn('recuérdame en una hora estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'relative',amount:1,unit:'hour'}})));
  await turn('cuánto XP tengo?',scripted(call('xp.balance')));
  await turn('cancelalo',scripted(say('¿Qué quieres cancelar?')));
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('pending');
});
it('collection inputs keep their order through the existing worker and produce one retained PDF delivery',async()=>{
  await startCollection();await addFile();await addFile();
  const ids=(await db.query('SELECT partial_args FROM sessions_v2')).rows[0]?.partial_args.artifactIds as string[];
  const sources=[];for(const id of ids)sources.push({storedId:(await db.query('SELECT media_attachment_id FROM chat_artifacts WHERE id=$1',[id])).rows[0]?.media_attachment_id});
  await turn('terminar');const job=await claimMedia(db);expect(job).toBeDefined();expect((job?.payload as {sources:unknown[]}).sources).toEqual(sources);
  const root=await mkdtemp(join(tmpdir(),'botsky-parity-worker-'));
  try{
    await processMedia(db,config,job!,{root,download:async()=>{throw new Error('unexpected download');},attachment:async()=>{throw new Error('unexpected recapture');},process:async(cwd,input)=>{expect(input.operation).toBe('images_pdf');expect(input.inputs).toHaveLength(2);await writeFile(join(cwd,'result.pdf'),pdf);return {files:['result.pdf']};}});
    expect((await db.query('SELECT status FROM jobs')).rows).toEqual([{status:'done'}]);
    expect((await db.query("SELECT count(*)::int n FROM outbox WHERE kind='media_result'")).rows[0]?.n).toBe(1);
    expect((await db.query("SELECT count(*)::int n FROM chat_artifacts WHERE origin='bot_output'")).rows[0]?.n).toBe(1);
  }finally{await rm(root,{recursive:true,force:true});}
});
it('capability discovery is not a ToolExecution and still permits the single truth retry',async()=>{
  const llm=scripted(call('core.load_capability',{domain:'web'}),say('No hace falta buscar.'),call('web.search',{query:'prueba'}));
  const search=vi.fn(async()=> 'Fuente\nDato verificable.\nhttps://example.org/');
  await context({text:'busca en la web esto botsky'},ctx=>route({...ctx,search},llm));
  expect(search).toHaveBeenCalledOnce();expect(llm.generate).toHaveBeenCalledTimes(3);
  expect((await db.query('SELECT tool_name FROM tool_executions')).rows).toEqual([{tool_name:'web.search'}]);
});
it('a real web failure is reported once without a capability retry or invented results',async()=>{
  const search=vi.fn(async()=>{throw new Error('network unavailable');});
  const llm=scripted(call('web.search',{query:'prueba'}));
  const output=await context({text:'busca esto en la web botsky'},ctx=>route({...ctx,search},llm));
  expect(output).toContain('No pude completar la búsqueda');expect(search).toHaveBeenCalledOnce();expect(llm.generate).toHaveBeenCalledOnce();
  expect((await db.query('SELECT tool_name,status FROM tool_executions')).rows).toEqual([{tool_name:'web.search',status:'error'}]);
});
it('reordering a collected set is a different action and cannot reuse a success receipt',async()=>{
  await context({},ctx=>backing(ctx,{mime:'image/png',bytes:png}));await context({},ctx=>backing(ctx,{mime:'image/png',bytes:png}));
  const llm=scripted(input=>{
    const envelope=JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text);
    const refs=envelope.REFERENCE_DATA.recentArtifacts.map((a:{ref:string})=>a.ref) as string[];
    return {text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:'media_process',args:{operation:'images_pdf',artifactRefs:refs}}},{functionCall:{name:'media_process',args:{operation:'images_pdf',artifactRefs:[...refs].reverse()}}}]}};
  });
  const result=await turn('botsky haz un PDF con esas fotos',llm);expect(result.text).toContain('Solo puedo preparar un archivo por mensaje');
  expect(await count('jobs')).toBe(1);expect((await db.query('SELECT status FROM tool_executions ORDER BY created_at')).rows).toEqual([{status:'queued'},{status:'denied'}]);
});
