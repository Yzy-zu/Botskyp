import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { createRegistry } from '../src/core/registry.js';
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
import { artifactsForTurn } from '../src/core/chat-artifacts.js';
import { buildTurnContextV2 } from '../src/core/context-v2.js';
import { rememberContextResultV2 } from '../src/core/context-results-v2.js';
import { openClarificationV2,readSessionV2 } from '../src/core/sessions-v2.js';
import { transaction } from '../src/db/client.js';
import { resolveSemanticTime } from '../src/modules/reminders/semantic-time.js';
import { receive,processNext } from '../src/core/inbox.js';
import { parityConversation } from './fixtures/v1.1/ws-parity-1.js';
import * as minecraft from '../src/modules/minecraft/client.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg } from '../src/wa/types.js';
const call=(name:string,args:unknown={}):LlmReply=>({text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:name.replaceAll('.','_'),args}}]}});
const say=(text:string):LlmReply=>({text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'conversation',text,effects:[]})}]}});
function scripted(...outputs:(LlmReply|((input:LlmInput)=>LlmReply))[]){
  const catalog=createToolRegistryV2(createRegistry());
  let expanded=false;
  return {generate:vi.fn<Llm['generate']>(async input=>{
    const next=outputs.shift();if(!next)throw new Error('Unexpected provider call');
    const output=typeof next==='function'?next(input):next;
    const body=output.content as {parts?:{functionCall?:{name:string;args?:Record<string,unknown>}}[]};
    for(const part of body.parts ?? []){
      const call=part.functionCall;
      if(call?.name==='media_process' && call.args && !call.args.artifactRef && !call.args.artifactRefs && !['qr_create','speak','download'].includes(String(call.args.operation))){
        const state=JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text).ARTIFACT_STATE as {CURRENT:{ref:string}[];REPLIED?:{ref:string};A_LAST?:{ref:string}};
        const selected=state.CURRENT[0] ?? state.REPLIED ?? state.A_LAST;
        if(selected)call.args.artifactRef=selected.ref;
      }
    }
    const content=output.content as {parts?:{functionCall?:{name:string}}[]};
    const call=content.parts?.find(p=>p.functionCall)?.functionCall;
    const tool=call?catalog.find(t=>t.name.replaceAll('.','_').replaceAll('-','_')===call.name):undefined;
    if(tool && !input.tools.some(t=>t.name===call?.name) && !expanded){
      outputs.unshift(output);expanded=true;
      return {text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:'core_load_capability',args:{domain:tool.domain,toolName:tool.name}}}]}};
    }
    return output;
  })};
}
const refEnvelope=(input:LlmInput)=>{
  const root=JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text) as Record<string,unknown>;
  for(const content of input.contents.slice(1) as {parts?:{functionResponse?:{response?:{context?:Record<string,unknown>}}}[]}[])for(const part of content.parts ?? [])Object.assign(root,part.functionResponse?.response?.context ?? {});
  return root.REFERENCE_DATA as {reminders:{ref:string}[];activeSession?:{kind:string;pendingTool:string;partialArgs:Record<string,unknown>;missingSlots?:string[];lastQuestion?:string;collection?:{operation:string;files:number}}};
};
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
it.each(parityConversation)('Canary fixture: $text → $tool through Policy (with capability discovery when needed)',async fixture=>{
  const target=fixture.tool.replaceAll('.','_');
  const llm=scripted(
    input=>input.tools.some(t=>t.name===target)?call(fixture.tool,fixture.args):call('core.load_capability',{domain:fixture.tool.split('.')[0]}),
    input=>{expect(input.tools.map(t=>t.name)).toContain(target);return call(fixture.tool,fixture.args);},
  );
  const output=await turn(fixture.text,llm);
  expect(output.text).not.toMatch(/p[aá]same.*IP|no.*permisos|no la tengo conectada/iu);
  expect((await db.query('SELECT tool_name,status FROM tool_executions WHERE turn_id=$1',[output.turnId])).rows).toEqual([{tool_name:fixture.tool,status:'ok'}]);
});
it.each(['minecraft.status','minecraft.players','xp.balance'] as const)('structured action_required recovers %s through discovery',async name=>{
  const action:LlmReply={text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'action_required',text:'Falta ejecutar.',effects:[]})}]}};
  const llm=scripted(action,call(name));
  const output=await turn('...',llm);
  expect(output.text).not.toMatch(/IP/u);
  expect((await db.query('SELECT tool_name FROM tool_executions WHERE turn_id=$1',[output.turnId])).rows).toEqual([{tool_name:name}]);
});
it('ordinary conversation cannot trigger a retry based on capability words',async()=>{
  const llm=scripted(say('Respuesta sin acción.'));
  expect((await turn('está activo el servidor?',llm)).text).toBe('Respuesta sin acción.');expect(llm.generate).toHaveBeenCalledOnce();
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
  const llm=scripted({text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'action_required',text:'Falta buscar.',effects:[]})}]}},call('web.search',{query:'Elon Musk parentesco'}),say('No encontré evidencia. Fuente: https://example.org/evidencia'));
  const output=await context({text:'busca en la web si elon musk es mi tío botsky'},ctx=>route({...ctx,search},llm));
  expect(output).toContain('No encontré evidencia');expect(search).toHaveBeenCalledOnce();
  expect((await db.query('SELECT tool_name,status FROM tool_executions')).rows).toEqual([{tool_name:'web.search',status:'ok'}]);
});
it('structured SemanticTimeInput resolves 20:00 without re-inspecting raw text and requires missing_date for kind=clock',()=>{
  expect(resolveSemanticTime({kind:'clock',hour:8,meridiem:'pm'},new Date('2026-10-17T18:00:00Z'))).toEqual({status:'needs_clarification',code:'missing_date'});
  for(const clock of [{hour:8,meridiem:'pm' as const},{hour:20},{hour:8,meridiem:'night' as const}]){
    const result=resolveSemanticTime({kind:'tomorrow',...clock},new Date('2026-10-17T18:00:00Z'));
    expect(result.status).toBe('ok');if(result.status==='ok')expect(DateTime.fromJSDate(result.dueAt,{zone:'America/Mexico_City'}).hour).toBe(20);
  }
});
it('exact Canary reminder: clock 8pm → mañana via Gemini activeSession → cancelalo via reminders.cancel',async()=>{
  const initial=await turn('guarda un recordatorio para las 8pm, di q estoy tonto',scripted(call('reminders.create',{body:'estoy tonto',time:{kind:'clock',hour:8,meridiem:'pm'}})));
  expect(initial.text).toContain('hoy o mañana');expect(initial.text).not.toContain('mañana o de la noche');expect(await count('reminders')).toBe(0);
  const second=await turn('mañana',scripted(input=>{
    expect(refEnvelope(input).activeSession).toMatchObject({kind:'clarify',pendingTool:'reminders.create',partialArgs:{body:'estoy tonto',time:{kind:'clock',hour:20,minute:0,meridiem:'pm'}},missingSlots:['date'],lastQuestion:'¿Para hoy o mañana?'});
    return call('reminders.create',{time:{kind:'tomorrow',hour:20,minute:0,meridiem:'pm'}});
  }));
  expect(second.text).toContain('recordaré');
  const row=(await db.query<{due_at:Date;status:string;body:string}>('SELECT due_at,status,body FROM reminders')).rows[0]!;
  expect(row.body).toBe('estoy tonto');
  expect(DateTime.fromJSDate(row.due_at,{zone:'America/Mexico_City'}).toFormat('yyyy-MM-dd HH:mm')).toBe(DateTime.now().setZone('America/Mexico_City').plus({days:1}).toFormat('yyyy-MM-dd')+' 20:00');
  const cancelTurn=scripted(input=>{
    return call('reminders.cancel',{reminderRef:refEnvelope(input).reminders[0]!.ref});
  });
  expect((await turn('cancelalo',cancelTurn)).text).toContain('cancelé');
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('cancelled');
});
it('partial slots accept tomorrow before the requested period and keep it after de la noche via Gemini',async()=>{
  await turn('guarda un recordatorio a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'clock',hour:8}})));
  expect((await turn('mañana',scripted(call('reminders.create',{time:{kind:'tomorrow',hour:8}})))).text).toContain('mañana o de la noche');
  expect(await count('reminders')).toBe(0);
  expect((await turn('De la noche',scripted(call('reminders.create',{time:{kind:'tomorrow',hour:8,meridiem:'pm'}})))).text).toContain('recordaré');
  expect((await db.query("SELECT body,to_char(due_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') due FROM reminders")).rows[0]).toEqual({
    body:'estudiar',
    due:DateTime.now().setZone('America/Mexico_City').plus({days:1}).toFormat('yyyy-MM-dd')+' 20:00',
  });
});
it('slot correction: Gemini updates tomorrow 20:00 to Friday 21:00 while preserving original body without manual parser',async()=>{
  await transaction(db,c=>openClarificationV2(c,'v1_1',{actorId:owner,chatId:chat,pendingTool:'reminders.create',partialArgs:{body:'estudiar',time:{kind:'tomorrow',hour:20,minute:0,meridiem:'pm'}},missingSlots:[{kind:'choice',field:'date',choices:['today','tomorrow']}],prompt:'¿Confirmas mañana a las 8pm?',code:'MISSING_DATE',now:new Date()}));
  const llm=scripted(input=>{
    expect(refEnvelope(input).activeSession?.partialArgs).toEqual({body:'estudiar',time:{kind:'tomorrow',hour:20,minute:0,meridiem:'pm'}});
    return call('reminders.create',{time:{kind:'weekday',weekday:5,hour:9,meridiem:'pm'}});
  });
  const result=await turn('nel mejor el viernes como a las nueve',llm);
  expect(result.text).toContain('recordaré');
  const saved=(await db.query<{body:string;clock:string;isodow:number}>("SELECT body,to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') clock,EXTRACT(ISODOW FROM due_at AT TIME ZONE 'America/Mexico_City')::int isodow FROM reminders")).rows[0]!;
  expect(saved).toEqual({body:'estudiar',clock:'21:00',isodow:5});
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('done');
});
it('a new XP intent escapes a pending reminder slot while keeping the reminder session active and intact',async()=>{
  await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8}})));
  expect((await turn('cuanto xp tengo we',scripted(call('xp.balance')))).text).toContain('XP');
  expect(await count('reminders')).toBe(0);
  expect((await db.query('SELECT status,pending_tool FROM sessions_v2')).rows[0]).toEqual({status:'active',pending_tool:'reminders.create'});
});
it.each(['cancela','cancelalo','nel','ni madres','mejor no','ya estuvo','olvídalo'])('cancels a pending session via core.session_cancel with %s',async text=>{
  await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8}})));
  const llm=scripted(input=>{
    expect(input.tools.map(t=>t.name)).toContain('core_session_cancel');
    return call('core.session_cancel');
  });
  expect((await turn(text,llm)).text).toContain('cancelado');
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('cancelled');
  expect(await count('reminders')).toBe(0);
});
it('recent cancellation is actor/chat scoped and needs a recent receipt',async()=>{
  await turn('recuérdame en una hora estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'relative',amount:1,unit:'hour'}})));
  await turn('cancelalo',scripted(say('¿Cuál recordatorio?')),undefined,{senderId:member});
  await turn('cancelalo',scripted(say('¿Cuál recordatorio?')),undefined,{chatId:'400@g.us'});
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('pending');
});
it('inbox activates tomorrow and immediate cancellation without callword, with dedupe',async()=>{
  const enabled={...config,GEMINI_API_KEY:'mock-key',GEMINI_FREE_TIER_CONFIRMED:true};
  const generate=vi.spyOn(Gemini.prototype,'generate')
    .mockResolvedValueOnce(call('reminders.create',{body:'estudiar',time:{kind:'clock',hour:8,meridiem:'pm'}}))
    .mockResolvedValueOnce(call('reminders.create',{time:{kind:'tomorrow',hour:20,minute:0,meridiem:'pm'}}))
    .mockResolvedValueOnce(call('core.load_capability',{domain:'productivity',toolName:'reminders.cancel'}))
    .mockImplementationOnce(async input=>call('reminders.cancel',{reminderRef:refEnvelope(input).reminders[0]!.ref}));
  for(const text of ['botsky guarda un recordatorio para las 8pm, di estudiar','mañana','cancelalo']){
    const msg:Msg={id:randomUUID(),chatId:chat,senderId:owner,isGroup:true,fromMe:false,ts:new Date(),text,mentions:[],attachments:[]};
    await receive(db,enabled,msg);await processNext(db,enabled);
    expect(await receive(db,enabled,msg)).toBe('duplicate');
  }
  expect((await db.query('SELECT status FROM reminders')).rows).toEqual([{status:'cancelled'}]);
  expect(generate).toHaveBeenCalledTimes(4);
});
it('si botsky confirms the existing preview via core.session_confirm; changed permissions still prevent Nuclear',async()=>{
  await turn('activa la nuclear botsky',scripted(call('bulk.nuclear',{text:'hola'})));
  expect(await count('bulk_ops')).toBe(0);
  await db.query(`UPDATE chats SET settings='{"modules":{"messaging":false}}' WHERE id=$1`,[chat]);
  expect((await turn('si botsky',scripted(call('core.session_confirm')))).text).toContain('apagado');expect(await count('bulk_ops')).toBe(0);
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
  const result=await turn('no me enviaste mi pdf botsky',scripted(call('media.status')));expect(result.text).toContain('conversión a PDF falló');expect(result.text).toContain('tardó demasiado');expect(result.text).not.toMatch(/Archivo [1-5]|sticker|confirmado/iu);
});
it('media history stays bounded and independent of human wording and never claims an unconfirmed delivery',async()=>{
  await db.query(`INSERT INTO jobs(kind,chat_id,owner_id,status,payload) VALUES('media',$1,$2,'done','{"operation":"office_pdf"}'),('media',$1,$2,'running','{"operation":"sticker"}')`,[chat,owner]);
  const one=await turn('no me llegó botsky',scripted(call('media.status')));expect(one.text?.split('\n')).toHaveLength(2);
  const history=await turn('mis trabajos botsky',scripted(call('media.status')));expect(history.text?.split('\n')).toHaveLength(2);expect(history.text).toContain('envío sigue pendiente');
});
async function startCollection(operation:'images_pdf'|'pdf_merge'='images_pdf'){
  return turn(operation==='images_pdf'?'hazme un pdf con estas fotos botsky':'une mis pdf botsky',scripted(call('media.collect',{operation})));
}
async function addFile(mime='image/png',bytes=png,id=randomUUID()){
  return turn('',scripted(),ctx=>backing(ctx,{mime,bytes}).then(()=>undefined),{id,attachments:[{kind:mime.startsWith('image/')?'image':'document',ref:`${id}:file`,mime}]});
}
it.each(['ya','termina','hazlo'])('media.collect: two images → %s → one job, with scoped retained inputs',async finish=>{
  expect((await startCollection()).text).toContain('Voy a reunir');expect((await addFile()).text).toContain('1 foto');expect((await addFile()).text).toContain('2 fotos');
  await turn(finish,scripted(call('media.collect',{operation:'images_pdf',action:'finish'})));expect(await count('jobs')).toBe(1);
  const job=(await db.query('SELECT payload FROM jobs')).rows[0]!.payload;expect(job.operation).toBe('images_pdf');expect(job.sources).toHaveLength(2);expect(new Set(job.sources.map((s:{storedId:string})=>s.storedId)).size).toBe(2);
  expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('done');
});
it('media.collect dedupes repeated input, rejects incompatible files and permits a new intent',async()=>{
  await startCollection();const id=randomUUID();await addFile('image/png',png,id);await turn('',scripted(),undefined,{id,attachments:[{kind:'image',ref:`${id}:file`,mime:'image/png'}]});
  expect((await addFile('application/pdf',pdf)).text).toContain('no es una foto');
  expect((await turn('cuánto XP tengo?',scripted(call('xp.balance')))).text).toContain('XP');
  await turn('terminar',scripted(call('media.collect',{operation:'images_pdf',action:'finish'})));expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload.sources).toHaveLength(1);
});
it('media.collect merges two PDFs using the same jobs',async()=>{
  await startCollection('pdf_merge');await addFile('application/pdf',pdf);expect((await turn('terminar',scripted(call('media.collect',{operation:'pdf_merge',action:'finish'})))).text).toContain('al menos dos');await addFile('application/pdf',pdf);await turn('terminar',scripted(call('media.collect',{operation:'pdf_merge',action:'finish'})));
  expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload).toMatchObject({operation:'pdf_merge',sources:[expect.any(Object),expect.any(Object)]});
});
it.each(['cancel','expire','module','actor','chat','backing'] as const)('media.collect preserves %s boundaries',async change=>{
  await startCollection();await addFile();
  if(change==='cancel')await turn('mejor no',scripted(call('core.session_cancel')));
  if(change==='expire')await db.query("UPDATE sessions_v2 SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second'");
  if(change==='module')await db.query(`UPDATE chats SET settings='{"modules":{"media":false}}' WHERE id=$1`,[chat]);
  if(change==='backing')await db.query('UPDATE media_attachments SET data=NULL');
  await turn('terminar',scripted(change==='cancel'||change==='expire'||change==='actor'||change==='chat'?say('No hay colección disponible.'):call('media.collect',{operation:'images_pdf',action:'finish'})),undefined,change==='actor'?{senderId:member}:change==='chat'?{chatId:'400@g.us'}:{});
  expect(await count('jobs')).toBe(0);
});
it('a pending reminder updates partial_args in the same session when still incomplete',async()=>{
  await transaction(db,c=>openClarificationV2(c,'v1_1',{actorId:owner,chatId:chat,pendingTool:'reminders.create',partialArgs:{body:'estudiar',time:{kind:'clock',hour:8}},missingSlots:[{kind:'choice',field:'date',choices:['today','tomorrow']},{kind:'am_pm',hour:8}],prompt:'¿Para hoy o mañana, y a las 8 de la mañana o de la noche?',code:'MISSING_DATE',now:new Date()}));
  await turn('el viernes',scripted(call('reminders.create',{time:{kind:'weekday',weekday:5,hour:8}})));
  await turn('mejor a las 10',scripted(call('reminders.create',{time:{kind:'weekday',weekday:5,hour:10}})));
  await context({},async ctx=>{const s=await readSessionV2(ctx.c,owner,chat);expect((s?.partial_args.time as {hour:number}).hour).toBe(10);const snapshot=await buildTurnContextV2(ctx);expect(snapshot.envelope.REFERENCE_DATA.activeSession).toBeDefined();});
  expect(await count('sessions_v2')).toBe(1);
});
it('changing the hour while date is missing preserves the missing date slot',async()=>{
  await turn('guarda un recordatorio para las 8pm, di estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'clock',hour:8,meridiem:'pm'}})));
  expect((await turn('sí pero mejor a las 9',scripted(call('reminders.create',{time:{kind:'clock',hour:9,meridiem:'pm'}})))).text).toContain('hoy o mañana');expect(await count('reminders')).toBe(0);
  await turn('mañana',scripted(call('reminders.create',{time:{kind:'tomorrow',hour:9,meridiem:'pm'}})));
  expect((await db.query("SELECT to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') clock FROM reminders")).rows[0]?.clock).toBe('21:00');
});
it('resolves model-supplied SemanticTimeInput without re-inspecting raw user text',async()=>{
  const result=await turn('recuérdame mañana a las 8piem estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8,meridiem:'pm'}})));
  expect(result.text).toContain('recordaré');expect(await count('reminders')).toBe(1);
  expect((await db.query("SELECT to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') clock FROM reminders")).rows[0]?.clock).toBe('20:00');
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
  await turn('terminar',scripted(call('media.collect',{operation:'images_pdf',action:'finish'})));const job=await claimMedia(db);expect(job).toBeDefined();expect((job?.payload as {sources:unknown[]}).sources).toEqual(sources);
  const root=await mkdtemp(join(tmpdir(),'botsky-parity-worker-'));
  try{
    await processMedia(db,config,job!,{root,download:async()=>{throw new Error('unexpected download');},attachment:async()=>{throw new Error('unexpected recapture');},process:async(cwd,input)=>{expect(input.operation).toBe('images_pdf');expect(input.inputs).toHaveLength(2);await writeFile(join(cwd,'result.pdf'),pdf);return {files:['result.pdf']};}});
    expect((await db.query('SELECT status FROM jobs')).rows).toEqual([{status:'done'}]);
    expect((await db.query("SELECT count(*)::int n FROM outbox WHERE kind='media_result'")).rows[0]?.n).toBe(1);
    expect((await db.query("SELECT count(*)::int n FROM chat_artifacts WHERE origin='bot_output'")).rows[0]?.n).toBe(1);
  }finally{await rm(root,{recursive:true,force:true});}
});
it('capability discovery is not a ToolExecution and still permits the single truth retry',async()=>{
  const llm=scripted(call('core.load_capability',{domain:'web'}),{text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'action_required',text:'Falta buscar.',effects:[]})}]}},call('web.search',{query:'prueba'}));
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
it.each(['ya son todas','ya están todas','que ya son todas botsky entiende'])('Canary collection closes naturally with %s',async text=>{
  await startCollection();await addFile();await addFile();await turn(text,scripted(call('media.collect',{operation:'images_pdf',action:'finish'})));
  expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload.sources).toHaveLength(2);
});
it('repeated media.collect keeps the foreground files and original expiry',async()=>{
  await startCollection();await addFile();await addFile();
  const before=(await db.query('SELECT id,partial_args,expires_at FROM sessions_v2')).rows[0]!;
  await turn('botsky sigue reuniendo esas fotos',scripted(call('media.collect',{operation:'images_pdf'})));
  const after=(await db.query('SELECT id,partial_args,expires_at FROM sessions_v2')).rows[0]!;
  expect(after).toEqual(before);expect(await count('sessions_v2')).toBe(1);
  await turn('terminar',scripted(call('media.collect',{operation:'images_pdf',action:'finish'})));expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload.sources).toHaveLength(2);
});
it('a scheduled recuerdo with a spoken PM period asks the day and preserves tomorrow',async()=>{
  const llm=scripted(input=>{expect(input.tools.find(t=>t.name==='reminders_create')?.description).toContain('clock');return call('reminders.create',{body:'estoy tonto',time:{kind:'clock',hour:8,meridiem:'pm'}});});
  expect((await turn('botsky guarda un recuerdo para las ocho peeme di q estoy tonto',llm)).text).toContain('hoy o mañana');
  const second=scripted(()=>call('reminders.create',{time:{kind:'tomorrow',hour:20,minute:0,meridiem:'pm'}}));
  await turn('mañana',second);
  const cancelTurn=scripted(input=>call('reminders.cancel',{reminderRef:refEnvelope(input).reminders[0]!.ref}));
  expect((await turn('cancelalo',cancelTurn)).text).toContain('cancelé');
});
async function quotedOcrFixture(){
  const artifact=await context({},ctx=>backing(ctx,{mime:'image/png',bytes:png}));const provider=randomUUID();
  const job=(await db.query(`INSERT INTO jobs(kind,chat_id,owner_id,status,payload) VALUES('media',$1,$2,'done',$3) RETURNING id`,[chat,owner,JSON.stringify({operation:'ocr',sources:[{storedId:artifact.media_attachment_id}]})])).rows[0]!;
  await db.query(`INSERT INTO outbox(chat_id,kind,status,provider_msg_id,payload,dedupe_key) VALUES($1,'media_text','sent',$2,$3,$4)`,[chat,provider,JSON.stringify({text:'Texto leído',jobId:job.id}),randomUUID()]);
  return {provider,artifact};
}
it('Canary sticker reply to sent OCR text resolves its exact image without copying semantic text',async()=>{
  const {provider,artifact}=await quotedOcrFixture();
  await turn('hazla Sticker',scripted(call('media.process',{operation:'sticker',artifactRef:'A_REPLY'})),undefined,{quoted:{id:provider,fromBot:false}});
  const job=(await db.query("SELECT payload FROM jobs WHERE payload->>'operation'='sticker'")).rows[0]!;
  expect(job.payload.sources).toEqual([{storedId:artifact.media_attachment_id}]);
});
it.each(['actor','chat','unsent','backing'] as const)('text-result source resolution respects %s provenance',async change=>{
  const {provider}=await quotedOcrFixture();
  if(change==='unsent')await db.query("UPDATE outbox SET status='queued'");
  if(change==='backing')await db.query('UPDATE media_attachments SET data=NULL');
  const result=await turn('botsky haz sticker de eso',scripted(call('media.process',{operation:'sticker',artifactRef:'A_REPLY'})),undefined,{quoted:{id:provider,fromBot:true},...(change==='actor'?{senderId:member}:change==='chat'?{chatId:'400@g.us'}:{})});
  if(change==='chat'){
    expect(result.text).toContain('No tengo ese archivo');
    await context({chatId:'400@g.us'},async ctx=>expect((await artifactsForTurn(ctx.c,{chatId:ctx.chat.id,actorId:ctx.actor.id,sourceMessageId:ctx.msg.id,quotedMessageId:provider,now:ctx.now,resolveTextResultSource:true})).reply).toEqual([]));
  }else expect(result.text).toContain('No tengo ese archivo');
  expect((await db.query("SELECT count(*)::int n FROM jobs WHERE payload->>'operation'='sticker'")).rows[0]?.n).toBe(0);
});
it('an explicit Spanish calendar date keeps its day without asking again',async()=>{
  const day=DateTime.now().setZone('America/Mexico_City').plus({days:2});
  const text=`botsky recuérdame estudiar el ${day.setLocale('es-MX').toFormat("d 'de' LLLL")} a las 8pm`;
  expect((await turn(text,scripted(call('reminders.create',{body:'estudiar',time:{kind:'date',date:day.toISODate()!,hour:8,meridiem:'pm'}})))).text).toContain('recordaré');
});
it.each(['para hoy','para mañana','para oí, para las 8 piem','QUE PARA OOIII'])('Canary pending date receives activeSession and completes via Gemini for %s',async answer=>{
  await turn('botsky guarda un rekor para las 8piem y di q estoy tontiks',scripted(call('reminders.create',{body:'estoy tontiks',time:{kind:'clock',hour:8,meridiem:'pm'}})));
  const cont=scripted(input=>{
    expect(refEnvelope(input).activeSession).toMatchObject({kind:'clarify',pendingTool:'reminders.create',partialArgs:{body:'estoy tontiks',time:{kind:'clock',hour:20,minute:0,meridiem:'pm'}}});
    return call('reminders.create',{time:{kind:answer.includes('mañana')?'tomorrow':'today',hour:20,minute:0,meridiem:'pm'}});
  });
  const result=await turn(answer,cont);
  if(!answer.includes('mañana') && DateTime.now().setZone('America/Mexico_City').hour>=20){
    expect(result.text).not.toContain('recordaré');expect(await count('reminders')).toBe(0);return;
  }
  expect(result.text).toContain('recordaré');
  const r=(await db.query('SELECT body,due_at FROM reminders')).rows[0]!;expect(r.body).toBe('estoy tontiks');
  const local=DateTime.fromJSDate(r.due_at,{zone:'America/Mexico_City'});expect(local.hour).toBe(20);
  expect(local.toISODate()).toBe(DateTime.now().setZone('America/Mexico_City').plus({days:answer.includes('mañana')?1:0}).toISODate());
  const cancelTurn=scripted(input=>call('reminders.cancel',{reminderRef:refEnvelope(input).reminders[0]!.ref}));
  expect((await turn('cancelalo',cancelTurn)).text).toContain('cancelé');
});
it('an unrelated oí reply still escapes a reminder period slot',async()=>{
  await turn('recuérdame mañana a las 8',scripted(call('reminders.create',{body:'estudiar',time:{kind:'tomorrow',hour:8}})));
  const llm=scripted(say('Te escucho.'));await turn('oí',llm);expect(llm.generate).toHaveBeenCalledOnce();expect(await count('reminders')).toBe(0);
});
it.each(['kon esas hazlo','QUE CON ESAS YA MALDITO'])('model finish closes the scoped collection naturally: %s',async text=>{
  await startCollection();await addFile();await addFile();
  const llm=scripted(input=>{
    const data=JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text).REFERENCE_DATA;
    expect(data.activeSession.collection).toEqual({operation:'images_pdf',files:2});
    expect(input.tools.find(t=>t.name==='media_collect')?.description).toContain('action=finish');
    return call('media.collect',{operation:'images_pdf',action:'finish'});
  });
  await turn(text,llm);expect(await count('jobs')).toBe(1);expect((await db.query('SELECT status FROM sessions_v2')).rows[0]?.status).toBe('done');
  expect((await db.query('SELECT tool_name,status FROM tool_executions ORDER BY created_at')).rows.slice(-2)).toEqual([{tool_name:'media.collect',status:'queued'},{tool_name:'media.process',status:'queued'}]);
});
it.each(['actor','chat','module','none'] as const)('model finish respects %s collection scope',async change=>{
  if(change!=='none'){await startCollection();await addFile();}
  if(change==='module')await db.query(`UPDATE chats SET settings='{"modules":{"media":false}}' WHERE id=$1`,[chat]);
  await turn('botsky con esas fotos hazlo',scripted(call('media.collect',{operation:'images_pdf',action:'finish'})),undefined,change==='actor'?{senderId:member}:change==='chat'?{chatId:'400@g.us'}:{});
  expect(await count('jobs')).toBe(0);
});
it('model finish replay queues one job with the original collected files',async()=>{
  await startCollection();await addFile();await addFile();
  await turn('botsky con esas fotos hazlo',scripted({text:'',calls:[],content:{role:'model',parts:[1,2].map(()=>({functionCall:{name:'media_collect',args:{operation:'images_pdf',action:'finish'}}}))}}));
  expect(await count('jobs')).toBe(1);expect((await db.query('SELECT payload FROM jobs')).rows[0]?.payload.sources).toHaveLength(2);
});
it('Canary cancelalo mejor cancels the recent reminder via reminders.cancel and never fabricates an annulment',async()=>{
  await turn('botsky recuérdame en una hora estudiar',scripted(call('reminders.create',{body:'estudiar',time:{kind:'relative',amount:1,unit:'hour'}})));
  const cancelTurn=scripted(input=>{
    return call('reminders.cancel',{reminderRef:refEnvelope(input).reminders[0]!.ref});
  });
  expect((await turn('cancelalo mejor',cancelTurn)).text).toContain('cancelé');
  expect((await db.query('SELECT status FROM reminders')).rows).toEqual([{status:'cancelled'}]);
});
it('Canary plural recordatorios exposes the actual list tool',async()=>{
  await turn('que recordatorios hay activos?',scripted(call('core.load_capability',{domain:'productivity'}),input=>{expect(input.tools.map(t=>t.name)).toContain('reminders_list');return call('reminders.list');}));
  expect((await db.query('SELECT tool_name,status FROM tool_executions')).rows).toEqual([{tool_name:'reminders.list',status:'ok'}]);
});
it.each(['Pues ya te lo anulé, carnal.','Ya lo cancelé.'])('blocks the unsupported Canary effect claim: %s',async text=>{
  expect((await turn('botsky no me hagas dar vueltas',scripted(say(text)))).text).toContain('No ejecuté ninguna acción');
  expect(await count('tool_executions')).toBe(0);
});
