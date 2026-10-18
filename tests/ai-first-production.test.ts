import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db, config, owner, member, chat, initialize, reset, context, backing, png } from './r4-harness.js';
import { route } from '../src/core/router.js';
import { prepareArtifactsV2 } from '../src/core/prepare-artifacts-v2.js';
import { buildTurnContextV2 } from '../src/core/context-v2.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { selectToolExposure, ToolExposureTurn } from '../src/core/tool-exposure.js';
import { adapterAvailable } from '../src/core/policy-v2/arguments.js';
import { executeToolV2, evaluateToolV2 } from '../src/core/policy-v2/executor.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import { loadArtifactContextV2 } from '../src/core/artifact-context-v2.js';
import { configForChat, readConfig, routerModeForChat } from '../src/config.js';
import { receive, processNext } from '../src/core/inbox.js';
import { moduleEnabled } from '../src/core/permissions.js';
import type { Llm, LlmInput, LlmReply } from '../src/core/llm.js';

const catalog=createToolRegistryV2(createRegistry());
const enabledModules=[...new Set(catalog.map(t=>t.requiredModule)),'vision'];
const unseen=()=>randomBytes(32).toString('base64url');
const reply=(name:string,args:unknown={}):LlmReply=>({text:'',calls:[],content:{role:'model',parts:[{functionCall:{name,args},thoughtSignature:'keep-signed-call'}]}});
const answer=(outcome='conversation',text='Respuesta de prueba.'):LlmReply=>({text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome,text,effects:[]})}]}});
const envelope=(input:LlmInput)=>JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text) as Awaited<ReturnType<typeof buildTurnContextV2>>['envelope'];
beforeAll(initialize); beforeEach(reset); afterEach(()=>vi.restoreAllMocks()); afterAll(()=>db.end());

it('exposes all 96 public contracts and hides exactly two internal mechanisms',()=>{
  expect(catalog).toHaveLength(98);
  expect(catalog.filter(t=>t.llmVisible)).toHaveLength(96);
  expect(catalog.filter(t=>t.llmVisible && !adapterAvailable(t.name))).toEqual([]);
  expect(catalog.filter(t=>!t.llmVisible).map(t=>t.name).sort()).toEqual(['bulk.confirm','school.schedule_commit']);
  for(const tool of catalog.filter(t=>t.llmVisible)){
    const exposure=new ToolExposureTurn(catalog,{actorRole:'owner',chatType:tool.scope==='private'?'private':'group',enabledModules});
    expect(exposure.loadCapability({domain:tool.domain,toolName:tool.name}).status).toBe('ok');
    expect(exposure.exposure.toolNames).toContain(tool.name);
    expect(exposure.exposure.schemas.length).toBeLessThanOrEqual(20);
    exposure.fitSchemaBudget(8000);
    expect(exposure.exposure.toolNames).toContain(tool.name);
  }
});
it('never reads text/quotedText for exposure and discovers every domain without lexical signals',()=>{
  const input={actorRole:'owner' as const,chatType:'group' as const,enabledModules,get text():string{throw new Error('NLU forbidden');},get quotedText():string{throw new Error('NLU forbidden');}};
  expect(()=>selectToolExposure(catalog,input)).not.toThrow();
  for(const domain of [...new Set(catalog.map(t=>t.domain))]){
    const first=new ToolExposureTurn(catalog,{actorRole:'owner',chatType:'group',enabledModules,text:unseen(),quotedText:unseen()});
    expect(first.loadCapability({domain}).status).toBe('ok');
  }
});
it('routes even formerly exact human shortcuts through the model and Policy',async()=>{
  await db.query('INSERT INTO wallets(user_id,balance) VALUES($1,42)',[owner]);
  for(const text of ['botsky xp','botsky daily','botsky mc','botsky carta',unseen()]){
    const generate=vi.fn<Llm['generate']>(async()=>reply('xp_balance'));
    await context({text},async ctx=>{expect(await route(ctx,{generate})).toContain('42 XP');});
    expect(generate).toHaveBeenCalledOnce();
  }
});
it('memory intent is exclusively the valid model call, with sensitive data still denied',async()=>{
  await context({text:unseen()},async ctx=>{
    expect((await executeToolV2(ctx,'memory.remember',{body:'Prefiero el ajedrez.'},{callOrigin:'llm',safeRefMap:new SafeRefs([])})).status).toBe('ok');
  });
  await context({text:unseen()},async ctx=>{
    expect((await evaluateToolV2(ctx,'memory.remember',{body:'mi password es ejemplo'},{callOrigin:'llm',safeRefMap:new SafeRefs([])}))?.denialCode).toBe('DENIED_SENSITIVE_MEMORY');
  });
  expect((await db.query('SELECT body FROM user_memories')).rows).toEqual([{body:'Prefiero el ajedrez.'}]);
});
it('ingests two actual inbound attachments, dedupes independently, exposes refs and queues images_pdf through Policy',async()=>{
  const id=randomUUID(), childIds=[randomUUID(),randomUUID()];
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{
    const body=JSON.parse(String(options?.body)) as {message:{key:{id:string}}};
    expect(childIds).toContain(body.message.key.id);
    return new Response(JSON.stringify({mimetype:'image/png',base64:png.toString('base64')}),{status:200});
  });
  await context({id,text:'junta estas madres en un pdf',attachments:childIds.map(providerMessageId=>({kind:'image',mime:'image/png',ref:`${providerMessageId}:image`,providerMessageId}))},async ctx=>{
    const generate=vi.fn<Llm['generate']>(async input=>{
      const state=envelope(input).ARTIFACT_STATE!;
      expect(state.CURRENT).toHaveLength(2);
      expect(new Set(state.CURRENT.map(a=>a.ref)).size).toBe(2);
      expect(state.UNRETAINED_CURRENT).toBeUndefined();
      return reply('media_process',{operation:'images_pdf',artifactRefs:state.CURRENT.map(a=>a.ref)});
    });
    await route(ctx,{generate});
    await prepareArtifactsV2(ctx);
    expect(generate).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await db.query('SELECT artifact_index FROM media_attachments WHERE source_message_id=$1 ORDER BY artifact_index',[id])).rows).toEqual([{artifact_index:0},{artifact_index:1}]);
    expect((await db.query('SELECT id FROM chat_artifacts WHERE source_message_id=$1',[id])).rows).toHaveLength(2);
    const jobs=(await db.query<{payload:{operation:string;sources:unknown[]}}>("SELECT payload FROM jobs WHERE kind='media' AND source_message_id=$1",[id])).rows;
    expect(jobs).toHaveLength(1); expect(jobs[0]!.payload.operation).toBe('images_pdf');expect(jobs[0]!.payload.sources).toHaveLength(2);
    const snapshot=await buildTurnContextV2(ctx);
    const foreign=await context({senderId:member,text:unseen()},other=>executeToolV2(other,'media.process',{operation:'images_pdf',artifactRefs:snapshot.envelope.ARTIFACT_STATE!.CURRENT.map(a=>a.ref)},{callOrigin:'llm',safeRefMap:snapshot.safeRefMap}));
    expect(foreign.status).not.toBe('queued');
  });
});
it('does not bleed old vision, explicitly loads one chosen SafeRef and preserves signed provider history',async()=>{
  let artifactId='';
  await context({text:unseen()},async ctx=>{artifactId=(await backing(ctx,{mime:'image/png',bytes:png})).id;});
  let first:LlmInput|undefined;
  const generate=vi.fn<Llm['generate']>(async input=>{
    if(!first){
      first=structuredClone(input);
      expect(JSON.stringify(input.contents)).not.toContain('inlineData');
      const state=envelope(input).ARTIFACT_STATE!;
      expect(state.CURRENT).toEqual([]);expect(state.RECENT).toHaveLength(1);
      return reply('core_load_artifact_context',{artifactRef:state.RECENT[0]!.ref});
    }
    const contents=input.contents as {parts:Record<string,unknown>[]}[];
    expect(contents[1]!.parts[0]!.thoughtSignature).toBe('keep-signed-call');
    expect(contents[2]!.parts[0]).toMatchObject({functionResponse:{name:'core_load_artifact_context',response:{status:'ok'}}});
    expect(contents[2]!.parts[1]).toMatchObject({inlineData:{mimeType:'image/png',data:png.toString('base64')}});
    return answer();
  });
  await context({text:unseen()},async ctx=>{
    expect(await route(ctx,{generate})).toBe('Respuesta de prueba.');
    const snapshot=await buildTurnContextV2(ctx), ref=snapshot.envelope.ARTIFACT_STATE!.RECENT[0]!.ref;
    expect((await loadArtifactContextV2(ctx,snapshot.safeRefMap,{artifactRef:'artifactRef_'+unseen()})).status).not.toBe('ok');
    await db.query('UPDATE media_attachments SET expires_at=clock_timestamp()-interval \'1 second\' WHERE id=(SELECT media_attachment_id FROM chat_artifacts WHERE id=$1)',[artifactId]);
    expect((await loadArtifactContextV2(ctx,snapshot.safeRefMap,{artifactRef:ref})).status).not.toBe('ok');
  });
  expect(generate).toHaveBeenCalledTimes(2);
});
it('uses generic structured action_required retry, without tool forcing or input analysis',async()=>{
  let n=0;
  const generate=vi.fn<Llm['generate']>(async input=>{
    expect(input.requireFunctionCall).toBeUndefined();
    return n++===0?answer('action_required'):reply('notes_create',{body:'Dato exacto.'});
  });
  await context({text:unseen()},async ctx=>{expect(await route(ctx,{generate})).toContain('Dato exacto.');});
  expect(generate).toHaveBeenCalledTimes(2);
});
it('returns precise missingSlots and allows the model to ask the clarification',async()=>{
  let n=0;
  const generate=vi.fn<Llm['generate']>(async input=>{
    if(n++===0)return reply('reminders_create',{body:'Revisar el horno.'});
    expect(JSON.stringify(input.contents)).toContain('missingSlots');
    expect(JSON.stringify(input.contents)).toContain('MISSING_TIME');
    return answer('conversation','¿A qué hora quieres el aviso?');
  });
  await context({text:unseen()},async ctx=>{expect(await route(ctx,{generate})).toBe('¿A qué hora quieres el aviso?');});
  expect((await db.query('SELECT missing_slots FROM sessions_v2')).rows[0]?.missing_slots).toEqual([{kind:'required',field:'time'}]);
});
it('global mode ignores stale canary allowlists, preserves explicit module OFF and ignores unknown groups',async()=>{
  const global={...config,ROUTER_V1_1_CHAT_IDS:[chat]};
  for(const id of [chat,'400@g.us',owner,'999@g.us']){
    expect(routerModeForChat(global,id)).toBe('v1_1');expect(configForChat(global,id)).toBe(global);
  }
  expect(moduleEnabled({id:'400@g.us',isGroup:true,enabled:true,settings:{}},'media',global)).toBe(true);
  expect(moduleEnabled({id:'400@g.us',isGroup:true,enabled:true,settings:{modules:{media:false}}},'media',global)).toBe(false);
  const ignored=await receive(db,global,{id:randomUUID(),chatId:'999@g.us',senderId:owner,isGroup:true,ts:new Date(),text:'botsky '+unseen(),fromMe:false,mentions:[],attachments:[]});
  expect(ignored).toBe('ignored');expect(await processNext(db,global)).toBe(false);
  expect(readConfig({...process.env,TRANSPORT:'mock',DATABASE_URL:'postgresql://test:test@localhost/test',ROUTER_MODE:undefined}).ROUTER_MODE).toBe('v1_1');
});
it('keeps semantic gate modules out of v1.1 runtime and model schemas free of backend selectors',()=>{
  const router=readFileSync('src/core/router-v2.ts','utf8');
  expect(router).not.toMatch(/exactFastPathV2|artifact-relevance/);
  for(const name of ['tool-exposure.ts','prepare-artifacts-v2.ts','artifact-resolution-v2.ts','policy-v2/eligibility.ts','policy-v2/normalize.ts','tool-loop-v2.ts']){
    const source=readFileSync('src/core/'+name,'utf8');
    expect(source).not.toMatch(/(?:msg\.text|legacy\.msg\.text|input\.text|input\.quotedText)/);
    expect(source).not.toMatch(/referencesPreviousContent|explicitMemoryRequest|capabilityTruthTargets|lexicalDomains|semanticHints/);
  }
});

it('queues Drive upload from the selected retained artifact without falling back to raw text',async()=>{
  await db.query("UPDATE chats SET settings='{}'::jsonb || jsonb_build_object('drive',true) WHERE id=$1",[chat]);
  await context({text:unseen()},async ctx=>{
    const artifact=await backing(ctx,{mime:'image/png',bytes:png});
    const snapshot=await buildTurnContextV2(ctx);
    const ref=snapshot.envelope.ARTIFACT_STATE!.CURRENT[0]!.ref;
    const result=await executeToolV2({...ctx,config:{...ctx.config,DRIVE_ENABLED:true}},'drive.upload',{artifactRef:ref},{callOrigin:'llm',safeRefMap:snapshot.safeRefMap});
    expect(result.status).toBe('queued');
    expect((await db.query('SELECT payload FROM jobs WHERE kind=\'drive\'')).rows[0]?.payload).toEqual({operation:'upload',artifactId:artifact.id});
  });
});
it('previews a school schedule, commits only through a second-turn model confirmation, and detects revision changes',async()=>{
  const lessons=[{subject:'Materia nueva',weekday:1,start:'08:00',end:'09:00'}];
  const {continueConfirmationV2}=await import('../src/core/session-confirmation-v2.js');
  await context({text:unseen()},async ctx=>{
    const result=await executeToolV2(ctx,'school.schedule_propose',{lessons},{callOrigin:'llm',safeRefMap:new SafeRefs([])});
    expect(result.status).toBe('needs_confirmation');expect(result.data).toMatchObject({prompt:expect.stringContaining('Materia nueva')});
    expect((await db.query('SELECT * FROM school_schedule')).rows).toHaveLength(0);
  });
  await context({text:unseen()},async ctx=>{
    const result=await continueConfirmationV2(ctx,new SafeRefs([]));
    expect(result).toMatchObject({status:'ok'});
    expect((await db.query("SELECT name FROM school_subjects WHERE chat_id=$1",[chat])).rows).toEqual([{name:'Materia nueva'}]);
    expect((await db.query('SELECT * FROM school_schedule')).rows).toHaveLength(1);
  });
  await context({text:unseen()},ctx=>executeToolV2(ctx,'school.schedule_propose',{lessons},{callOrigin:'llm',safeRefMap:new SafeRefs([])}));
  await db.query('UPDATE school_config SET revision=revision+1 WHERE chat_id=$1',[chat]);
  await context({text:unseen()},async ctx=>expect(await continueConfirmationV2(ctx,new SafeRefs([]))).toMatchObject({status:'denied'}));
});

it.runIf(process.env.BOTSKY_AI_FIRST_LIVE==='1')('Gemini real resolves unseen local input through the real two-attachment inbound pipeline',async()=>{
  const {Gemini}=await import('../src/core/llm.js');
  const cases=JSON.parse(readFileSync('.local/ai-first-live-inputs.json','utf8')) as {multi:string;previous:string};
  const live=readConfig({...process.env,ROUTER_MODE:'v1_1',TRANSPORT:'mock',DATABASE_URL:config.DATABASE_URL,OWNER_JIDS:owner,LAB_CHAT_ID:chat});
  const nativeFetch=globalThis.fetch;
  const children=[randomUUID(),randomUUID()];
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>String(url).includes('/chat/getBase64FromMediaMessage/')?new Response(JSON.stringify({mimetype:'image/png',base64:png.toString('base64')})):nativeFetch(url,options));
  await context({text:cases.multi,attachments:children.map(providerMessageId=>({kind:'image',mime:'image/png',ref:`${providerMessageId}:image`,providerMessageId}))},async ctx=>{
    const provider=new Gemini(db,live,owner);
    const result=await route({...ctx,config:live},provider);
    const jobs=(await db.query<{payload:{operation:string;sources:unknown[]}}>("SELECT payload FROM jobs WHERE kind='media' AND source_message_id=$1",[ctx.msg.id])).rows;
    console.info('AI_FIRST_LIVE_MULTI',JSON.stringify({result,jobs:jobs.map(j=>({operation:j.payload.operation,sources:j.payload.sources.length})),calls:provider.counters.calls}));
    expect(jobs).toHaveLength(1);expect(jobs[0]!.payload.operation).toBe('images_pdf');expect(jobs[0]!.payload.sources).toHaveLength(2);
  });
  await context({text:cases.previous},async ctx=>{
    const provider=new Gemini(db,live,owner);
    const seen:LlmInput[]=[];
    const model:Llm={generate:async input=>{seen.push(structuredClone(input));return provider.generate(input);}};
    const result=await route({...ctx,config:live},model);
    expect(JSON.stringify(seen[0]?.contents)).not.toContain('inlineData');
    expect(seen.slice(1).some(input=>JSON.stringify(input.contents).includes('core_load_artifact_context') && JSON.stringify(input.contents).includes('inlineData'))).toBe(true);
    console.info('AI_FIRST_LIVE_PREVIOUS',JSON.stringify({result,calls:provider.counters.calls,selectedImage:true}));
  });
},120000);

it('media.search runs its existing backend and keeps selection in Zero-NLU SessionV2',async()=>{
  const sources=await import('../src/modules/media/sources.js');
  const choices=[{title:'Audio de ejemplo',url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.ogg',mime:'audio/ogg',size:100,page:'https://commons.wikimedia.org/wiki/File:Example.ogg'}];
  const search=vi.spyOn(sources,'searchMedia').mockResolvedValue(choices);
  await context({text:unseen()},async ctx=>{
    const result=await executeToolV2(ctx,'media.search',{query:'Audio de ejemplo',type:'audio'},{callOrigin:'llm',safeRefMap:new SafeRefs([])});
    expect(result.status).toBe('ok');expect(search).toHaveBeenCalledWith('Audio de ejemplo','audio');
    expect((await db.query("SELECT kind,pending_tool,partial_args FROM sessions_v2 WHERE status='active'")).rows[0]).toMatchObject({kind:'clarify',pending_tool:'media.process',partial_args:{operation:'download',choices}});
    expect((await db.query("SELECT * FROM sessions WHERE status='active'")).rows).toEqual([]);
  });
  await context({text:unseen()},async ctx=>{
    const result=await executeToolV2(ctx,'media.process',{url:choices[0]!.url},{callOrigin:'llm',safeRefMap:new SafeRefs([])});
    expect(result.status).toBe('queued');
    expect((await db.query("SELECT payload FROM jobs WHERE kind='media'")).rows[0]?.payload).toMatchObject({operation:'download',url:choices[0]!.url});
  });
});
it('school.destination resolves an authorized destination SafeRef with the existing handler',async()=>{
  await context({text:unseen()},async ctx=>{
    const snapshot=await buildTurnContextV2(ctx,['school']);
    const target=snapshot.envelope.REFERENCE_DATA.destinations?.find(d=>d.type==='group');
    expect(target).toBeDefined();
    const result=await executeToolV2(ctx,'school.destination',{destinationRef:target!.ref},{callOrigin:'llm',safeRefMap:snapshot.safeRefMap});
    expect(result.status).toBe('ok');
    expect((await db.query('SELECT target_group_id FROM school_config WHERE chat_id=$1',[chat])).rows[0]?.target_group_id).toBeTruthy();
  });
});
it('school.schedule_import reads the exact selected image and obtains a full preview before any school write',async()=>{
  const school=await import('../src/modules/school/schedule.js');
  const lessons=[{subject:'Materia extraída',weekday:2,start:'10:00',end:'11:00'}];
  const extract=vi.spyOn(school,'extractSchedule').mockResolvedValue({lessons});
  await context({text:unseen()},async ctx=>{
    await backing(ctx,{mime:'image/png',bytes:png});
    const snapshot=await buildTurnContextV2(ctx,['school']);
    const ref=snapshot.envelope.ARTIFACT_STATE!.CURRENT[0]!.ref;
    const imported=await executeToolV2(ctx,'school.schedule_import',{artifactRef:ref},{callOrigin:'llm',safeRefMap:snapshot.safeRefMap});
    expect(imported.status).toBe('ok');expect(imported.data).toEqual({lessons});expect(extract).toHaveBeenCalledOnce();
    expect((await db.query('SELECT * FROM school_schedule')).rows).toEqual([]);
    const preview=await executeToolV2(ctx,'school.schedule_propose',imported.data,{callOrigin:'llm',safeRefMap:snapshot.safeRefMap});
    expect(preview.status).toBe('needs_confirmation');expect(preview.data).toMatchObject({prompt:expect.stringContaining('Materia extraída')});
    expect((await db.query('SELECT * FROM school_schedule')).rows).toEqual([]);
  });
});

it('normal inbox processing retains both inbound images before exposing them to Gemini',async()=>{
  const {Gemini}=await import('../src/core/llm.js');
  const children=[randomUUID(),randomUUID()],id=randomUUID();
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(JSON.stringify({mimetype:'image/png',base64:png.toString('base64')})));
  const provider=vi.spyOn(Gemini.prototype,'generate').mockImplementation(async input=>{
    const current=envelope(input).ARTIFACT_STATE!.CURRENT;
    expect(current).toHaveLength(2);
    return reply('media_process',{operation:'images_pdf',artifactRefs:current.map(a=>a.ref)});
  });
  const inbound={id,text:'botsky '+unseen(),chatId:chat,senderId:owner,isGroup:true,ts:new Date(),fromMe:false,mentions:[],attachments:children.map(providerMessageId=>({kind:'image',mime:'image/png',ref:`${providerMessageId}:image`,providerMessageId}))};
  const runtime={...config,GEMINI_FREE_TIER_CONFIRMED:true};
  expect(await receive(db,runtime,inbound)).toBe('accepted');
  expect(await processNext(db,runtime)).toBe(true);
  expect(provider).toHaveBeenCalledOnce();
  expect((await db.query('SELECT status FROM inbox')).rows).toEqual([{status:'done'}]);
  expect((await db.query('SELECT payload FROM jobs WHERE source_message_id=$1',[id])).rows[0]?.payload.sources).toHaveLength(2);
  expect(await receive(db,runtime,inbound)).toBe('duplicate');
});
