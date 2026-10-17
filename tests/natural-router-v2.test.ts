import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll,beforeEach,afterAll,afterEach,it,expect,vi } from 'vitest';
import { db,config,owner,member,chat,initialize,reset,context,backing,png,pdf,count } from './r4-harness.js';
import { route } from '../src/core/router.js';
import { Gemini, LlmUnavailable, type Llm, type LlmReply, type LlmInput } from '../src/core/llm.js';
import { receive,processNext } from '../src/core/inbox.js';
import { naturalR5 } from './fixtures/v1.1/natural-r5.js';
import { sanitizeOutputV2 } from '../src/core/output-sanitizer-v2.js';
import { visibleToolResultV2,conversationTextV2 } from '../src/core/composer-v2.js';
import { publish } from '../src/modules/library/catalog.js';
import { libraryFiles } from './library-harness.js';
import { transaction } from '../src/db/client.js';
import * as minecraft from '../src/modules/minecraft/client.js';
import { claimMedia,processMedia,retainMedia, type WorkerDeps } from '../src/modules/media/worker.js';
import { reportMediaDeliveries } from '../src/modules/media/delivery.js';
import { sendNext } from '../src/wa/outbox.js';
import type { ToolCtx } from '../src/core/tools.js';
import type { Msg,Transport } from '../src/wa/types.js';

const clean=(text:string)=>expect(text).not.toMatch(/@s\.whatsapp\.net|@g\.us|[a-f0-9]{8}-[a-f0-9-]{27}|\b(?:queued|processing|uncertain)\b|Trabajo #|\{"|\b(?:notes|games|memory|minecraft|media|web)\.[a-z_]+/iu);
const reply=(calls:{name:string;args?:unknown;id?:string}[]):LlmReply=>({text:'',calls,content:{role:'model',extra:'keep',parts:[{thought:true,text:'hidden',thoughtSignature:'opaque-before'},...calls.map(functionCall=>({functionCall,thoughtSignature:'opaque-call',custom:{keep:true}}))]}});
const say=(text:string,structured=true):LlmReply=>{const out=structured?JSON.stringify({outcome:'conversation',text,effects:[]}):text;return {text:out,calls:[],content:{role:'model',parts:[{text:out}]}};};
function scripted(...outputs:(LlmReply|((input:LlmInput)=>LlmReply))[]){return {generate:vi.fn<Llm['generate']>(async input=>{const next=outputs.shift();if(!next)throw new Error('Unexpected provider call');return typeof next==='function'?next(input):next;})};}
const envelope=(input:LlmInput)=>JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text) as {REFERENCE_DATA:{nowLocal:string;poll?:{pollRef:string};notes:{ref:string}[];reminders:{ref:string}[]}};
async function turn(text:string,llm:Llm,setup?:(ctx:ToolCtx)=>Promise<void>,input:Partial<Msg>={}){
  return context({text,...input},async ctx=>{await setup?.(ctx);const result=await route(ctx,llm);if(result)clean(result);return {text:result,turnId:ctx.turnId};});
}
let root:string;
beforeAll(async()=>{await initialize();root=await mkdtemp(join(tmpdir(),'botsky-r5-'));});
beforeEach(async()=>{
  await reset();
  await db.query('TRUNCATE library_items,library_blobs,library_syncs,minecraft_operations,messaging_destinations CASCADE');
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,1000)',[owner]);
  vi.spyOn(minecraft,'callMinecraft').mockImplementation(async (request,id)=>({v:1,id:id ?? 'mock-id',ok:true,action:request.action,code:'ok',data:{online:true,running:true,uptimeSeconds:10,players:2,maxPlayers:10,names:['Alex','Steve']}}));
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{await rm(root,{recursive:true,force:true});await db.end();});

it.each(naturalR5)('natural provider selection: $text → $tool',async fixture=>{
  if('poll' in fixture)await db.query(`WITH p AS (INSERT INTO polls(chat_id,author_id,source_id,question,status,closes_at) VALUES($1,$2,$3,'¿Qué comemos?','open',now()+interval '1 day') RETURNING id)
    INSERT INTO poll_options(poll_id,idx,label) SELECT id,1,'Tacos' FROM p UNION ALL SELECT id,2,'Pizza' FROM p`,[chat,owner,randomUUID()]);
  const llm=scripted(input=>{
    const name=fixture.tool.replaceAll('.','_');
    expect(input.tools.map(t=>t.name)).toContain(name);
    const args={...fixture.args,...(fixture.tool==='school.schedule'?{weekday:DateTime.fromISO(envelope(input).REFERENCE_DATA.nowLocal).plus({days:1}).weekday}:{}),...('poll' in fixture?{pollRef:envelope(input).REFERENCE_DATA.poll!.pollRef}:{})};
    return reply([{id:'Provider-ID/Exact==',name,args}]);
  });
  const output=await turn(fixture.text,llm,undefined,'private' in fixture?{chatId:owner,isGroup:false}:{});
  expect(output.text?.toLowerCase()).toContain(fixture.expected.toLowerCase());
  expect(llm.generate).toHaveBeenCalledOnce();
  const receipt=(await db.query('SELECT tool_name,status,provider_call_id FROM tool_executions WHERE turn_id=$1',[output.turnId])).rows;
  expect(receipt).toEqual([{tool_name:fixture.tool,status:'ok',provider_call_id:'Provider-ID/Exact=='}]);
  if('table' in fixture)expect(await count(fixture.table)).toBe(1);
  if(fixture.tool==='memory.remember')expect(await count('notes')).toBe(0);
});

it.each(['Ya quedó guardado.','Voto registrado por tacos.','Ya te di 25 XP.','Recordatorio creado.','Mensaje enviado.','Ya guardé ese dato.','Ya envié el mensaje.','Ya registré tu voto.','Ya programé el recordatorio.'])('blocks false success without any current receipt: %s',async text=>{
  for(const structured of [false,true]){
    const llm=scripted(say(text,structured),say(text,structured));
    const result=await turn('botsky haz esa acción',llm);
    expect(result.text).toBe('No ejecuté ninguna acción para esa solicitud.');
    expect(llm.generate).toHaveBeenCalledOnce();
    expect((await db.query('SELECT 1 FROM tool_executions WHERE turn_id=$1',[result.turnId])).rowCount).toBe(0);
  }
});
it('retries structured action intent once, then executes a real memory write',async()=>{
  const llm=scripted(say(JSON.stringify({outcome:'action_required',text:'Lo haré',effects:[]}),false),reply([{id:'memory-current',name:'memory_remember',args:{body:'estudio sistemas'}}]));
  expect((await turn('oye acuérdate de que estudio sistemas',llm)).text).toContain('guardé');
  expect(await count('user_memories')).toBe(1);
  expect(JSON.stringify(llm.generate.mock.calls[1]?.[0])).toContain('El usuario pidió una acción.');
});
it.each(['hola','cuánto es 2+2','explícame la gravedad','qué opinas de esto'])('allows ordinary conversation without tools: %s',async text=>{
  const llm=scripted(say('Aquí tienes una respuesta útil.'));
  expect((await turn(text,llm)).text).toBe('Aquí tienes una respuesta útil.');
  expect(await count('tool_executions')).toBe(0);expect(llm.generate).toHaveBeenCalledOnce();
});
it('exact fast path uses Policy and execution without Gemini; partial input goes natural',async()=>{
  const llm=scripted(reply([{name:'xp_balance',args:{}}]));
  expect((await turn('bot xp',llm)).text).toContain('1000 XP');expect(llm.generate).not.toHaveBeenCalled();
  expect((await turn('bot xp porfa',llm)).text).toContain('1000 XP');expect(llm.generate).toHaveBeenCalledOnce();
});
it.each([{actorId:owner},{chatId:chat},{role:'owner'},{nested:{actorId:owner}}])('strict model args cannot inject backend context: %j',async extra=>{
  const result=await turn('anota algo',scripted(reply([{name:'notes_create',args:{body:'injected',...extra}}])),undefined,{senderId:member});
  expect(result.text).toContain('datos válidos');expect(await count('notes')).toBe(0);
  expect((await db.query('SELECT actor_id,status FROM tool_executions WHERE turn_id=$1',[result.turnId])).rows).toEqual([{actor_id:member,status:'denied'}]);
});
it.each(['minecraft_restart','bulk_nuclear'])('member denial is natural and produces no administrative operation: %s',async name=>{
  const output=await turn(name==='bulk_nuclear'?'botsky haz nuclear':'botsky reinicia minecraft',scripted(reply([{name,args:name==='bulk_nuclear'?{text:'hola'}:{}}])),undefined,{senderId:member});
  expect(output.text).toContain('dueño');expect(await count('bulk_ops')).toBe(0);expect(await count('minecraft_operations')).toBe(0);
});
it('admin cannot use owner-only infrastructure',async()=>{
  await db.query('UPDATE group_memberships SET is_admin=true WHERE user_id=$1',[member]);
  expect((await turn('reinicia minecraft',scripted(reply([{name:'minecraft_restart',args:{}}])),undefined,{senderId:member})).text).toContain('dueño');
});
it('owner confirmation is SessionV2 + reevaluated Policy, with no real Minecraft restart',async()=>{
  const initial=await turn('reinicia minecraft',scripted(reply([{name:'minecraft_restart',args:{}}])));
  expect(initial.text).toContain('¿Seguro que reinicio');expect(await count('minecraft_operations')).toBe(0);
  const llm=scripted();expect((await turn('sí',llm)).text).toContain('Todavía no está confirmado');
  expect(llm.generate).not.toHaveBeenCalled();expect(await count('minecraft_operations')).toBe(1);
  expect(minecraft.callMinecraft).not.toHaveBeenCalled();
  expect((await db.query('SELECT count(DISTINCT turn_id)::int n FROM tool_executions')).rows[0]?.n).toBe(2);
});
it('notes confirmation describes the note, then really deletes through Policy',async()=>{
  await db.query('INSERT INTO notes(chat_id,author_id,body) VALUES($1,$2,\'comprar tortillas\')',[chat,owner]);
  const llm=scripted(input=>reply([{name:'notes_delete',args:{noteRef:envelope(input).REFERENCE_DATA.notes[0]!.ref}}]));
  expect((await turn('borra la nota',llm)).text).toContain('nota «comprar tortillas»');
  expect((await turn('sí',scripted())).text).toContain('borré');
  expect((await db.query('SELECT deleted_at FROM notes')).rows[0]?.deleted_at).toBeTruthy();
});
it('one capability expansion loads library, preserves the same turn and executes cooperacha.open',async()=>{
  await transaction(db,c=>publish(c,'local',libraryFiles()));
  const initial=reply([{name:'core_load_capability',id:'Load/Exact==',args:{domain:'library'}}]);
  const llm=scripted(initial,input=>{
    expect(input.contents[1]).toEqual(initial.content);
    expect(input.tools.map(t=>t.name)).toContain('cooperacha_open');
    expect(JSON.stringify(input.contents[2])).toContain('Load/Exact==');
    return reply([{name:'cooperacha_open',id:'Open/Exact==',args:{}}]);
  });
  const result=await turn('armemos una colecta entre todos',llm);
  expect(await count('cooperachas')).toBe(1);expect(result.text).toContain('500');
  expect((await db.query('SELECT tool_name,turn_id FROM tool_executions')).rows).toEqual([{tool_name:'cooperacha.open',turn_id:result.turnId}]);
});
it('bounds repeated capability expansion and tool proposals',async()=>{
  const llm=scripted(reply([{name:'core_load_capability',args:{domain:'games'}}]),reply([{name:'core_load_capability',args:{domain:'media'}}]));
  await turn('hola',llm);expect(llm.generate).toHaveBeenCalledTimes(2);
  const multi=scripted(reply(Array.from({length:5},(_,i)=>({name:'notes_create',id:`call-${i}`,args:{body:`nota ${i}`}}))));
  expect((await turn('anota varias cosas',multi)).text).toContain('límite');
  expect(await count('notes')).toBe(3);expect(await count('tool_executions')).toBe(3);
});
it('multi-tool reads synthesize real function responses and never execute synthesis calls',async()=>{
  const first=reply([{id:'schedule-exact',name:'school_schedule',args:{}},{id:'tasks-exact',name:'school_tasks',args:{}}]);
  const llm=scripted(first,input=>{
    expect(input.tools).toEqual([]);expect(input.contents[1]).toEqual(first.content);
    const serialized=JSON.stringify(input.contents[2]);expect(serialized).toContain('schedule-exact');expect(serialized).toContain('tasks-exact');
    expect(serialized).not.toMatch(/@s\.whatsapp|@g\.us|confirmationId/);
    return reply([{name:'notes_create',args:{body:'should not execute'}}]);
  });
  const output=await turn('qué clases tengo mañana y qué tareas hay?',llm);
  expect(output.text).toContain('No hay clases');expect(await count('notes')).toBe(0);
  expect(await count('tool_executions')).toBe(2);
});
it('web search answers the question using structured snippets and compact sources',async()=>{
  const llm=scripted(reply([{name:'web_search',id:'SearchID',args:{query:'ganador mundial 2022'}}]),input=>{
    const serialized=JSON.stringify(input.contents[2]);expect(serialized).toContain('Argentina ganó');expect(serialized).toContain('snippet');
    return say('Argentina ganó el Mundial de 2022. Fuente: https://www.fifa.com/');
  });
  const output=await context({text:'quién ganó el mundial de 2022?'},ctx=>route({...ctx,search:async()=> 'FIFA\nArgentina ganó el Mundial de 2022.\nhttps://www.fifa.com/'},llm));
  expect(output).toContain('Argentina ganó el Mundial');expect(llm.generate).toHaveBeenCalledTimes(2);
});
it('P0 regression: world cup, dollar and XP execute only their current calls',async()=>{
  const intents=[['quién ganó mundial?','web_search',{query:'mundial 2022'}],['y el dólar?','web_search',{query:'dólar hoy'}],['cuánto xp tengo?','xp_balance',{}]] as const;
  for(const [text,name,args] of intents){
    const llm=scripted(reply([{name,id:'same-provider-id-across-turns',args}]),say('Resultado verificado.'));
    const result=await turn(text,llm);
    expect((await db.query('SELECT tool_name FROM tool_executions WHERE turn_id=$1',[result.turnId])).rows).toEqual([{tool_name:name.replace('_','.')}]);
    expect((llm.generate.mock.calls[0]![0].contents)).toHaveLength(1);
  }
});
it('reminder AM/PM continuation creates 20:00 without Gemini and a new intent escapes',async()=>{
  const request=()=>scripted(reply([{name:'reminders_create',args:{body:'estudiar',time:{kind:'tomorrow',hour:8}}}]));
  expect((await turn('recuérdame mañana a las 8',request())).text).toContain('mañana o de la noche');
  expect(await count('reminders')).toBe(0);
  const noGemini=scripted();expect((await turn('de la noche',noGemini)).text?.toLowerCase()).toContain('recordaré');expect(noGemini.generate).not.toHaveBeenCalled();
  expect((await db.query("SELECT to_char(due_at AT TIME ZONE 'America/Mexico_City','HH24:MI') clock FROM reminders")).rows[0]?.clock).toBe('20:00');
  await turn('recuérdame mañana a las 8',request());
  const escape=scripted(reply([{name:'xp_balance',args:{}}]));
  expect((await turn('mejor cuánto xp tengo?',escape)).text).toContain('XP');expect(escape.generate).toHaveBeenCalledOnce();
});
it('Gemini failure before effects is honest; synthesis timeout preserves successful results',async()=>{
  const unavailable={generate:vi.fn(async()=>{throw new LlmUnavailable('timeout');})};
  expect((await turn('hola',unavailable)).text).toContain('no pudo responder');
  const llm=scripted(reply([{name:'web_search',args:{query:'x'}}]));
  const output=await turn('busca x',llm);expect(output.text).toContain('no pude preparar');expect(await count('tool_executions')).toBe(1);
});
it.each(['qué raza será?','qué dice ahí?','cuánto cuesta esto?','qué opinas de este meme?'])('vision uses the same actual image without question-specific heuristics: %s',async text=>{
  await context({text:'foto'},async ctx=>{await backing(ctx,{mime:'image/png',bytes:png});});
  const llm=scripted(input=>{
    expect(JSON.stringify(input.contents)).toContain(png.toString('base64'));
    return say('Veo la imagen. No puedo asegurar la raza o el precio solo con esta foto.');
  });
  expect((await turn(text,llm)).text).toContain('Veo la imagen');expect(llm.generate).toHaveBeenCalledOnce();
});
it.each(['100@s.whatsapp.net','123e4567-e89b-12d3-a456-426614174000','2026-10-17T12:00:00Z','/home/botsky/.env','notes.create','{"actorId":"x"}','GEMINI_API_KEY','Gemini','Trabajo #13','queued','uncertain'])('output sanitizer removes internal UX: %s',async internal=>{
  const output=sanitizeOutputV2(`Dato interno: ${internal}`);expect(output).not.toContain(internal);clean(output);
});
it('function responses never export IDs, paths, hashes, exceptions or secrets',()=>{
  const result=visibleToolResultV2({status:'ok',toolName:'notes.list',domain:'productivity',code:'NOTES_LIST',data:{notes:[{id:'12',body:'tortillas',actorId:owner}],confirmationHash:'secret',path:'/etc/passwd',exception:'SQL SELECT secret'}});
  expect(JSON.stringify(result)).toContain('tortillas');expect(JSON.stringify(result)).not.toMatch(/actorId|confirmationHash|secret|\/etc|exception|"id"/);
  expect(conversationTextV2(JSON.stringify({outcome:'conversation',text:'Listo',effects:[{action:'memory.remember',status:'ok'}]})).retry).toBe(false);
});
it('full inbox commits tool effect, receipt, sanitized reply and dedupe together without crossed locks',async()=>{
  vi.spyOn(Gemini.prototype,'generate').mockResolvedValue(reply([{name:'memory_remember',id:'current',args:{body:'estudio sistemas'}}]));
  const msg:Msg={id:randomUUID(),chatId:chat,senderId:owner,isGroup:true,fromMe:false,ts:new Date(),text:'oye botsky acuérdate de que estudio sistemas',mentions:[],attachments:[]};
  const enabled={...config,GEMINI_API_KEY:'mock-key',GEMINI_FREE_TIER_CONFIRMED:true};
  await receive(db,enabled,msg);expect(await processNext(db,enabled)).toBe(true);
  expect(await count('user_memories')).toBe(1);expect(await count('tool_executions')).toBe(1);expect(await count('outbox')).toBe(1);
  expect((await db.query('SELECT payload FROM outbox')).rows[0]?.payload.text).toContain('memoria personal');
  expect(await receive(db,enabled,msg)).toBe('duplicate');expect(await processNext(db,enabled)).toBe(false);
});
it('blackjack sequence uses active game context for hit and stand, with real persisted moves',async()=>{
  await turn('jalo blackjack de 20',scripted(reply([{name:'games_blackjack',args:{bet:20}}])));
  // Fix the random deck after admission so the regression is independent of blackjack naturals.
  const game=(await db.query<{id:string;state:Record<string,unknown>}>('SELECT id,state FROM games')).rows[0]!;
  await db.query(`UPDATE games SET status='playing',state=$2,expires_at=now()+interval '1 minute' WHERE id=$1`,[game.id,JSON.stringify({...game.state,deck:[9,8,7,6,5,4,3,2],dealer:[9,7],players:[{id:owner,bet:20,hand:[2,3],stood:false}],turn:0,results:undefined})]);
  await db.query('UPDATE game_players SET active=true WHERE game_id=$1',[game.id]);
  const hit=scripted(input=>{expect(JSON.stringify(input.contents)).toContain('yourHand');return reply([{name:'games_play',args:{move:'hit'}}]);});
  expect((await turn('dame otra carta',hit)).text).toContain('Blackjack');
  expect((await db.query('SELECT state FROM games')).rows[0]?.state.players[0].hand).toHaveLength(3);
  expect((await turn('me planto',scripted(reply([{name:'games_play',args:{move:'stand'}}])))).text).toContain('Blackjack');
  expect((await db.query('SELECT status FROM games')).rows[0]?.status).toBe('done');
  expect((await db.query('SELECT tool_name FROM tool_executions ORDER BY created_at')).rows.map(r=>r.tool_name)).toEqual(['games.blackjack','games.play','games.play']);
});
it('last reminder cancellation resolves SafeRef and never captures a different intent',async()=>{
  await turn('recuérdame en media hora estudiar',scripted(reply([{name:'reminders_create',args:{body:'estudiar',time:{kind:'relative',amount:30,unit:'minute'}}}])));
  const llm=scripted(input=>reply([{name:'reminders_cancel',args:{reminderRef:envelope(input).REFERENCE_DATA.reminders[0]!.ref}}]));
  expect((await turn('cancela el último recordatorio',llm)).text).toContain('cancelé');
  expect((await db.query('SELECT status FROM reminders')).rows[0]?.status).toBe('cancelled');
});
it('current image and reply image are captured by authenticated key regardless of question',async()=>{
  const http=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({mimetype:'image/png',base64:png.toString('base64')}));
  const id=randomUUID();
  const llm=scripted(input=>{expect(JSON.stringify(input.contents)).toContain(png.toString('base64'));return say('Veo una imagen.');});
  await turn('qué dice ahí?',llm,undefined,{id,attachments:[{kind:'image',ref:`${id}:image`,mime:'image/png'}]});
  expect(http).toHaveBeenCalledOnce();
  const quoted=scripted(input=>{expect(JSON.stringify(input.contents)).toContain(png.toString('base64'));return say('La imagen citada está disponible.');});
  await turn('qué raza será?',quoted,undefined,{quoted:{id,fromBot:false}});expect(http).toHaveBeenCalledOnce();
});

const mediaDeps=(text='Texto legible.'):WorkerDeps=>({root,download:vi.fn(async()=>{throw new Error('unexpected_download');}),attachment:vi.fn(async()=>{throw new Error('unexpected_attachment');}),process:vi.fn(async cwd=>{await writeFile(join(cwd,'result.txt'),text);return {files:['result.txt']};})});
const sentTransport=()=>({state:async()=>true,send:vi.fn<Transport['send']>(async()=>({status:'sent',id:`sent-${randomUUID()}`})),reconcile:async()=>({status:'unknown' as const})});
async function processNextMedia(deps:WorkerDeps){const job=await claimMedia(db);expect(job).toBeDefined();await processMedia(db,config,job!,deps);return job!;}
it.each(['ocr','qr_read','read'])('short %s results go directly to chat; no .txt delivery and no quick progress',async operation=>{
  const before=await turn('botsky léelo',scripted(reply([{name:'media_process',args:{operation}}])),async ctx=>{await backing(ctx,{mime:operation==='read'?'application/pdf':'image/png',bytes:operation==='read'?pdf:png});});
  expect(before.text).toBeUndefined();
  await processNextMedia(mediaDeps('Dos líneas\nde texto.'));
  const final=(await db.query("SELECT kind,payload FROM outbox WHERE status='queued'")).rows;
  expect(final).toHaveLength(1);expect(final[0]?.kind).toBe('media_text');expect(final[0]?.payload.text).toBe('Dos líneas\nde texto.');
  const transport=sentTransport();await sendNext(db,transport,config);
  expect(transport.send).toHaveBeenCalledOnce();expect(transport.send.mock.calls[0]?.[0].media).toBeUndefined();expect(transport.send.mock.calls[0]?.[0].attachmentId).toBeUndefined();
});
it('long text gets a preview plus retained .txt with safe filename',async()=>{
  await turn('léelo',scripted(reply([{name:'media_process',args:{operation:'read'}}])),async ctx=>{await backing(ctx);});
  await processNextMedia(mediaDeps('texto '.repeat(600)));
  const transport=sentTransport();await sendNext(db,transport,config);
  const delivery=transport.send.mock.calls[0]?.[0];expect(delivery?.text).toContain('Te adjunto el texto completo');expect(delivery?.media?.mime).toBe('text/plain');expect(delivery?.media?.fileName).toBe('botsky-resultado-1.txt');clean(delivery?.text ?? '');
});
it('ocr_empty has its specific natural error; progress appears only after the delay',async()=>{
  await turn('qué dice ahí?',scripted(reply([{name:'media_process',args:{operation:'ocr'}}])),async ctx=>{await backing(ctx,{mime:'image/png',bytes:png});});
  const transport=sentTransport();expect(await sendNext(db,transport,config)).toBe(false);expect(transport.send).not.toHaveBeenCalled();
  await db.query("UPDATE outbox SET next_try_at=now()-interval '1 second' WHERE kind='media_progress'");
  expect(await sendNext(db,transport,config)).toBe(true);expect(transport.send.mock.calls[0]?.[0].text).toContain('Aguanta');
  const deps=mediaDeps();deps.process=vi.fn(async()=>{throw new Error('ocr_empty');});
  await processNextMedia(deps);
  expect((await db.query("SELECT payload FROM outbox WHERE dedupe_key LIKE '%:error'")).rows[0]?.payload.text).toBe('Revisé la imagen pero no encontré texto legible.');
});
it('DOCX → PDF → compressed PDF → read → resend preserves the artifact chain without refetching',async()=>{
  await turn('conviértelo a pdf plis',scripted(reply([{name:'media_process',args:{operation:'office_pdf'}}])),async ctx=>{
    await backing(ctx,{mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:Buffer.from('PK\x03\x04fixture'),filename:'tarea.docx'});
  });
  const makePdf=mediaDeps();makePdf.process=vi.fn(async cwd=>{await writeFile(join(cwd,'result.pdf'),pdf);return {files:['result.pdf']};});
  await processNextMedia(makePdf);
  expect((await db.query("SELECT payload->>'text' text FROM outbox WHERE kind='media_result'")).rows[0]?.text).toBe('Listo, aquí tienes tu PDF.');
  await turn('ahora comprímelo',scripted(reply([{name:'media_process',args:{operation:'pdf_compress'}}])));
  await processNextMedia(makePdf);
  const chain=(await db.query('SELECT id,parent_artifact_id FROM chat_artifacts ORDER BY created_at')).rows;
  expect(chain).toHaveLength(3);expect(chain[1]?.parent_artifact_id).toBe(chain[0]?.id);expect(chain[2]?.parent_artifact_id).toBe(chain[1]?.id);
  await turn('léelo',scripted(reply([{name:'media_process',args:{operation:'read'}}])));await processNextMedia(mediaDeps('Contenido del PDF comprimido.'));
  await turn('pásamelo de nuevo',scripted(reply([{name:'media_process',args:{operation:'resend'}}])));
  expect(await count('jobs')).toBe(3);expect((await db.query("SELECT payload FROM outbox WHERE kind='artifact_resend'")).rows[0]?.payload.artifactId).toBe(chain[2]?.id);
  expect(makePdf.attachment).not.toHaveBeenCalled();
  const resend=(await db.query<{id:string}>("SELECT id FROM outbox WHERE kind='artifact_resend'")).rows[0]!;
  const {artifactResendDelivery}=await import('../src/core/artifact-resend-v2.js');
  const delivered=await artifactResendDelivery(db,config,{id:resend.id,chat_id:chat,payload:(await db.query('SELECT payload FROM outbox WHERE id=$1',[resend.id])).rows[0]?.payload});
  expect(delivered?.mime).toBe('application/pdf');expect(delivered?.fileName).toBe('botsky-archivo.pdf');
});
it('media delivery rechecks retention and cannot send expired text backing',async()=>{
  await turn('léelo',scripted(reply([{name:'media_process',args:{operation:'read'}}])),async ctx=>{await backing(ctx);});
  await processNextMedia(mediaDeps('Texto privado.'));
  await db.query("UPDATE media_attachments SET expires_at=now()-interval '1 second' WHERE NOT is_original");
  await retainMedia(db);
  expect((await db.query("SELECT payload->>'text' text FROM outbox WHERE kind='media_text'")).rows[0]?.text).not.toContain('Texto privado.');
  const transport=sentTransport();await sendNext(db,transport,config);expect(transport.send).not.toHaveBeenCalled();
  expect((await db.query("SELECT status FROM outbox WHERE kind='media_text'")).rows[0]?.status).toBe('failed');
  await reportMediaDeliveries(db,'v1_1');
  const notice=(await db.query("SELECT payload->>'text' text FROM outbox WHERE dedupe_key LIKE 'media:delivery-problem:%'")).rows[0]?.text as string;
  expect(notice).toContain('No pude confirmar');clean(notice);
});
it('real REST adapter preserves full signed model content, response IDs, turn accounting and safe synthesis payload',async()=>{
  const first=reply([{name:'web_search',id:'Exact/Provider-ID==',args:{query:'ganador mundial 2022'}}]);
  let requests=0;
  const http=vi.fn<typeof fetch>(async()=>Response.json({candidates:[{content:++requests===1?first.content:say('Argentina ganó el Mundial de 2022. Fuente: https://www.fifa.com/').content}],usageMetadata:{promptTokenCount:120,candidatesTokenCount:30}}));
  const adapter=new Gemini(db,{...config,GEMINI_API_KEY:'mock-key',GEMINI_FREE_TIER_CONFIRMED:true},owner,{used:0},http);
  const output=await context({text:'quién ganó el mundial de 2022?'},async ctx=>({turnId:ctx.turnId,text:await route({...ctx,search:async()=> 'FIFA\nArgentina ganó el Mundial de 2022.\nhttps://www.fifa.com/'},adapter)}));
  expect(output.text).toContain('Argentina ganó');expect(http).toHaveBeenCalledTimes(2);
  const body=JSON.parse(String(http.mock.calls[1]?.[1]?.body)) as {contents:unknown[]};
  expect(body.contents[1]).toEqual(first.content);
  expect(JSON.stringify(body.contents[2])).toContain('Exact/Provider-ID==');
  expect(JSON.stringify(body.contents[2])).not.toMatch(/@s\.whatsapp|confirmationId|actorId|toolName|\/home\//);
  expect((await db.query('SELECT turn_id,input_tokens,output_tokens FROM llm_usage WHERE turn_id=$1',[output.turnId])).rows).toEqual([{turn_id:output.turnId,input_tokens:120,output_tokens:30},{turn_id:output.turnId,input_tokens:120,output_tokens:30}]);
});
it('audio transcription delivers short text directly, with the worker provider mocked',async()=>{
  vi.spyOn(Gemini.prototype,'generate').mockResolvedValue(say('Hola, nos vemos mañana.',false));
  await turn('transcribe el audio',scripted(reply([{name:'media_process',args:{operation:'transcribe'}}])),async ctx=>{await backing(ctx,{mime:'audio/ogg',bytes:Buffer.from('OggSoriginal')});});
  const deps=mediaDeps();deps.process=vi.fn(async cwd=>{await writeFile(join(cwd,'result.ogg'),Buffer.from('OggSconverted'));return {files:['result.ogg']};});
  await processNextMedia(deps);
  expect((await db.query("SELECT kind,payload->>'text' text FROM outbox WHERE status='queued'")).rows).toEqual([{kind:'media_text',text:'Hola, nos vemos mañana.'}]);
});
it('ignores stale calls in an inconsistent legacy reply field; current original parts alone can execute',async()=>{
  const current=reply([{name:'xp_balance',args:{},id:'current-only'}]);current.calls.push({name:'notes_create',args:{body:'stale'}});
  const result=await turn('cuánto xp tengo?',scripted(current));
  expect(result.text).toContain('XP');expect(await count('notes')).toBe(0);
  expect((await db.query('SELECT tool_name FROM tool_executions WHERE turn_id=$1',[result.turnId])).rows).toEqual([{tool_name:'xp.balance'}]);
});
it.each(['school_schedule_propose','school_schedule_import','school_destination','media_search','media_collect','drive_upload'])('unsafe or unavailable bridge remains naturally blocked: %s',async name=>{
  const args=name==='media_search'?{query:'saludo',type:'audio'}:name==='media_collect'?{operation:'images_pdf'}:name==='school_schedule_propose'?{lessons:[]} : {};
  const result=await turn('botsky escuela media drive',scripted(reply([{name,args}])));
  expect(result.text).toMatch(/no pude|no está|apagado|válidos/iu);
  expect(await count('jobs')).toBe(0);expect(await count('school_imports')).toBe(0);expect(await count('bulk_ops')).toBe(0);
});
it('group member can ask about an explicitly quoted peer image without transferring its ownership',async()=>{
  const id=randomUUID();
  await context({id,senderId:member,text:'foto',attachments:[{kind:'image',ref:`${id}:image`,mime:'image/png'}]},async ctx=>{await backing(ctx,{mime:'image/png',bytes:png});});
  const llm=scripted(input=>{expect(JSON.stringify(input.contents)).toContain(png.toString('base64'));return say('Veo la imagen del mensaje citado.');});
  expect((await turn('qué opinas de este meme?',llm,undefined,{quoted:{id,fromBot:false,senderId:member}})).text).toContain('Veo');
  expect((await db.query('SELECT DISTINCT actor_id FROM chat_artifacts')).rows).toEqual([{actor_id:member}]);
});
it('inbox activation preserves AM/PM continuation and intent escape without another wake word',async()=>{
  const generate=vi.spyOn(Gemini.prototype,'generate').mockResolvedValue(reply([{name:'reminders_create',args:{body:'estudiar',time:{kind:'tomorrow',hour:8}}}]));
  const enabled={...config,GEMINI_API_KEY:'mock-key',GEMINI_FREE_TIER_CONFIRMED:true};
  const accept=async(text:string)=>{
    const msg:Msg={id:randomUUID(),chatId:chat,senderId:owner,isGroup:true,fromMe:false,ts:new Date(),text,mentions:[],attachments:[]};
    await receive(db,enabled,msg);await processNext(db,enabled);return msg;
  };
  await accept('botsky recuérdame mañana a las 8');expect(generate).toHaveBeenCalledOnce();
  await accept('de la noche');expect(generate).toHaveBeenCalledOnce();expect(await count('reminders')).toBe(1);
  await accept('botsky recuérdame mañana a las 8');
  generate.mockResolvedValue(reply([{name:'xp_balance',args:{}}]));
  const escape=await accept('mejor cuánto xp tengo?');expect(generate).toHaveBeenCalledTimes(3);
  expect((await db.query("SELECT payload->>'text' text FROM outbox WHERE payload->>'sourceId'=$1",[escape.id])).rows[0]?.text).toContain('XP');
});
it('rollback after a shared inbox execution removes both the effect and its receipt',async()=>{
  await context({text:'botsky anota tortillas'},async ctx=>{
    await expect(transaction(db,async c=>{
      const text=await route({...ctx,c,inboxTransaction:true},scripted(reply([{name:'notes_create',args:{body:'tortillas'}}])));
      expect(text).toContain('anoté');expect((await c.query('SELECT 1 FROM notes')).rowCount).toBe(1);
      throw new Error('simulated_inbox_failure');
    })).rejects.toThrow('simulated_inbox_failure');
  });
  expect(await count('notes')).toBe(0);expect(await count('tool_executions')).toBe(0);
});
it('a provider ID reused for a different tool cannot masquerade as an ok mutation',async()=>{
  const llm=scripted(reply([{id:'reused',name:'xp_balance',args:{}},{id:'reused',name:'memory_remember',args:{body:'estudio sistemas'}}]));
  const output=await turn('botsky acuérdate de que estudio sistemas y dime mis xp',llm);
  expect(output.text).toContain('XP');expect(output.text).not.toContain('guardé');
  expect(await count('user_memories')).toBe(0);expect(await count('tool_executions')).toBe(1);expect(llm.generate).toHaveBeenCalledOnce();
});

it('malformed conversational output cannot induce an action-selection retry',async()=>{
  const llm=scripted(say('Hola.',false));
  expect((await turn('hola',llm)).text).toContain('No pude preparar una respuesta clara');
  expect(llm.generate).toHaveBeenCalledOnce();expect(await count('tool_executions')).toBe(0);
});

it('distinct media operations in one turn cannot claim the same durable job as two effects',async()=>{
  const llm=scripted(reply([{id:'compress',name:'media_process',args:{operation:'pdf_compress'}},{id:'read',name:'media_process',args:{operation:'read'}}]));
  const output=await turn('comprime el PDF y léelo',llm,async ctx=>{await backing(ctx);});
  expect(output.text).toContain('un archivo por mensaje');expect(await count('jobs')).toBe(1);
  expect((await db.query('SELECT status FROM tool_executions WHERE turn_id=$1 ORDER BY created_at',[output.turnId])).rows).toEqual([{status:'queued'},{status:'denied'}]);
});
it('selected artifact identity is part of admission and distinct resends do not alias one receipt',async()=>{
  await context({},ctx=>backing(ctx));await context({},ctx=>backing(ctx));
  const llm=scripted(input=>{
    const data=JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text) as {REFERENCE_DATA:{recentArtifacts:{ref:string}[]}};
    const refs=data.REFERENCE_DATA.recentArtifacts;
    return reply(refs.slice(0,2).map((a,index)=>({id:`resend-${index}`,name:'media_process',args:{operation:'resend',artifactRef:a.ref}})));
  });
  const output=await turn('pásame esos dos archivos',llm);
  expect(output.text).toContain('un archivo por mensaje');
  expect((await db.query('SELECT status,args_hash FROM tool_executions WHERE turn_id=$1 ORDER BY created_at',[output.turnId])).rows.map(r=>r.status)).toEqual(['queued','denied']);
  expect((await db.query("SELECT 1 FROM outbox WHERE kind='artifact_resend'")).rowCount).toBe(1);
});

it('two different votes in a message cannot report a vote the historical dedupe did not cast',async()=>{
  await db.query(`WITH p AS (INSERT INTO polls(chat_id,author_id,source_id,question,status,closes_at) VALUES($1,$2,$3,'¿Comida?','open',now()+interval '1 day') RETURNING id)
    INSERT INTO poll_options(poll_id,idx,label) SELECT id,1,'Tacos' FROM p UNION ALL SELECT id,2,'Pizza' FROM p`,[chat,owner,randomUUID()]);
  const llm=scripted(input=>{
    const pollRef=envelope(input).REFERENCE_DATA.poll!.pollRef;
    return reply([{id:'tacos',name:'polls_vote',args:{pollRef,option:'Tacos'}},{id:'pizza',name:'polls_vote',args:{pollRef,option:'Pizza'}}]);
  });
  const output=await turn('voto tacos y después pizza',llm);
  expect(output.text).toContain('por Tacos');expect(output.text).not.toContain('por Pizza');
  expect((await db.query('SELECT option_idx FROM poll_votes')).rows).toEqual([{option_idx:1}]);
  expect((await db.query('SELECT status FROM tool_executions WHERE turn_id=$1 ORDER BY created_at',[output.turnId])).rows).toEqual([{status:'ok'},{status:'denied'}]);
});
it('two task creations cannot claim the first source-bound task as a second one',async()=>{
  await db.query("INSERT INTO school_subjects(chat_id,name) VALUES($1,'Matemáticas')",[chat]);
  const output=await turn('anota dos tareas de Matemáticas',scripted(reply([{id:'task-one',name:'school_task_create',args:{subject:'Matemáticas',title:'primera tarea'}},{id:'task-two',name:'school_task_create',args:{subject:'Matemáticas',title:'segunda tarea'}}])));
  expect(output.text).toContain('una acción de ese tipo');
  expect((await db.query('SELECT title FROM school_tasks')).rows).toEqual([{title:'primera tarea'}]);
  expect((await db.query('SELECT status FROM tool_executions WHERE turn_id=$1 ORDER BY created_at',[output.turnId])).rows).toEqual([{status:'ok'},{status:'denied'}]);
});
it('a game status and move cannot reuse one historical game action as two current effects',async()=>{
  const {initialState}=await import('../src/modules/games/state.js');
  const state=initialState(20),id=randomUUID();
  state.players=[{id:owner,bet:20,hand:[2,3],stood:false}];state.deck=[9,8,7,6];state.dealer=[4,5];
  await db.query("INSERT INTO games(id,chat_id,owner_id,kind,status,state,source_id,expires_at) VALUES($1,$2,$3,'blackjack','playing',$4,'fixture-game',now()+interval '1 minute')",[id,chat,owner,JSON.stringify(state)]);
  await db.query('INSERT INTO game_players(game_id,chat_id,user_id) VALUES($1,$2,$3)',[id,chat,owner]);
  const output=await turn('cómo voy y dame otra carta',scripted(reply([{id:'status',name:'games_status',args:{}},{id:'hit',name:'games_play',args:{move:'hit'}}])));
  expect(output.text).toContain('una acción de ese tipo');
  expect((await db.query('SELECT state FROM games WHERE id=$1',[id])).rows[0]?.state.players[0].hand).toEqual([2,3]);
  expect((await db.query('SELECT status FROM tool_executions WHERE turn_id=$1 ORDER BY created_at',[output.turnId])).rows).toEqual([{status:'ok'},{status:'denied'}]);
});
it('source admission preserves exact poll replay instead of casting or denying an identical vote twice',async()=>{
  await db.query(`WITH p AS (INSERT INTO polls(chat_id,author_id,source_id,question,status,closes_at) VALUES($1,$2,$3,'¿Comida?','open',now()+interval '1 day') RETURNING id)
    INSERT INTO poll_options(poll_id,idx,label) SELECT id,1,'Tacos' FROM p UNION ALL SELECT id,2,'Pizza' FROM p`,[chat,owner,randomUUID()]);
  const output=await turn('voto tacos',scripted(input=>{
    const args={pollRef:envelope(input).REFERENCE_DATA.poll!.pollRef,option:'Tacos'};
    return reply([{id:'one',name:'polls_vote',args},{id:'retry',name:'polls_vote',args}]);
  }));
  expect(output.text).toContain('por Tacos');expect(output.text).not.toContain('una acción de ese tipo');
  expect((await db.query('SELECT status FROM tool_executions WHERE turn_id=$1',[output.turnId])).rows).toEqual([{status:'ok'}]);
  expect(await count('poll_vote_events')).toBe(1);
});

it('multiple results never send authoritative XP or wagers back for model rewriting',async()=>{
  const llm=scripted(reply([{name:'xp_balance',id:'xp',args:{}},{name:'web_search',id:'web',args:{query:'ganador mundial 2022'}}]),say('Tienes 999999 XP.'));
  const text=await context({text:'cuánto xp tengo y quién ganó el mundial de 2022?'},ctx=>route({...ctx,search:async()=> 'FIFA\nArgentina ganó el Mundial de 2022.\nhttps://www.fifa.com/'},llm));
  expect(text).toContain('1000 XP');expect(text).toContain('Argentina ganó');expect(text).not.toContain('999999');
  expect(llm.generate).toHaveBeenCalledOnce();
});

it.each([owner,'123e4567-e89b-12d3-a456-426614174000','/home/private/file','GEMINI_API_KEY','{"actorId":"internal"}'])('function response message and data both sanitize user content: %s',value=>{
  const visible=visibleToolResultV2({status:'ok',toolName:'notes.list',domain:'productivity',code:'NOTES_LIST',data:{notes:[{id:'1',body:`Dato: ${value}`}]}});
  expect(JSON.stringify(visible)).not.toContain(value);
});
