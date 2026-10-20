import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { db, initialize, reset, context, backing, config, owner, member, chat, png } from './r4-harness.js';
import { createRegistry } from '../src/core/registry.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { capabilityManifestV2, capabilityAvailability, capabilityBehaviorV2 } from '../src/core/capability-manifest-v2.js';
import { modelArgsSchemas } from '../src/core/model-args.js';
import { conversions } from '../src/modules/media/catalog.js';
import { buildTurnContextV2, serializeContextV2 } from '../src/core/context-v2.js';
import { budgetContextV2, MAX_CONTEXT_CHARS } from '../src/core/context-budget-v2.js';
import { openClarificationV2 } from '../src/core/sessions-v2.js';
import { ToolExposureTurn } from '../src/core/tool-exposure.js';
import { capabilityDomains } from '../src/core/capability-domain.js';
import { routeNaturalV2, naturalRouterSystemV2 } from '../src/core/router-v2.js';
import { product } from '../config/product.js';
import { adapterAvailable } from '../src/core/policy-v2/arguments.js';

const registry=createRegistry(), catalog=createToolRegistryV2(registry);
const auth={actor:{id:owner,role:'owner' as const},chat:{id:chat,isGroup:true,enabled:true,settings:{}},config};
const manifest=capabilityManifestV2(catalog,auth);
beforeAll(initialize);beforeEach(reset);afterAll(()=>db.end());

it('covers every user-facing registry capability exactly once and accounts for every hidden tool',()=>{
  const publicTools=catalog.filter(t=>t.llmVisible && t.exposure!=='internal');
  const represented=manifest.split('\n').filter(line=>/^\w+[.][\w-]+:/u.test(line)).map(line=>line.split(':')[0]);
  const missing=publicTools.filter(t=>!represented.includes(t.name));
  expect(represented.sort()).toEqual(publicTools.map(t=>t.name).sort());
  expect(missing).toEqual([]);
  expect(new Set(represented).size).toBe(publicTools.length);
  for(const t of catalog.filter(t=>!t.llmVisible)){
    expect(t.hiddenReason?.length).toBeGreaterThan(10);expect(manifest).not.toContain(`${t.name}:`);
  }
  console.info(`registry user-facing capabilities: ${publicTools.length}; manifest capabilities represented: ${represented.length}; missing: ${missing.length}; hidden: ${catalog.length-publicTools.length}`);
});
it('fails closed if a registry tool is added without model contract or descriptive metadata',()=>{
  const incomplete=createRegistry();
  const existing=incomplete.all().find(t=>t.name==='notes.create')!;
  const saved=existing.capability!;
  try { delete existing.capability; expect(()=>createToolRegistryV2(incomplete)).toThrow('Missing public capability metadata: notes.create'); } finally { existing.capability=saved; }
  const unnamed=catalog.map(t=>t.name==='notes.create'?{...t,capability:{produces:'recibo'}}:t);
  expect(()=>capabilityManifestV2(unnamed,auth)).toThrow('Missing manifest metadata');
  const extra=createRegistry();
  extra.register({...registry.all()[0]!,name:'new.undescribed'});
  expect(()=>createToolRegistryV2(extra)).toThrow('catalog differs');
});
it('reflects changed registry descriptions automatically rather than a parallel prompt catalog',()=>{
  const changed=createRegistry(), tool=changed.all().find(t=>t.name==='core.ping')!;
  const saved=tool.description;
  try { tool.description='Diagnóstico actualizado desde Registry.'; expect(capabilityManifestV2(createToolRegistryV2(changed),auth)).toContain(tool.description); } finally { tool.description=saved; }
});
it('describes every real media operation with actual input/output formats and no DOCX output',()=>{
  const process=catalog.find(t=>t.name==='media.process')!;
  const operations=process.capability!.operations!;
  expect(Object.keys(operations).sort()).toEqual([...modelArgsSchemas['media.process'].shape.operation.options].sort());
  for(const [name,policy] of Object.entries(conversions)){
    expect(operations[name]?.produces).toBe(policy.outputs.join('/'));
    expect(manifest).toContain(`${name}: ${policy.description}`);
  }
  expect(Object.values(operations).some(op=>op.produces.includes('docx'))).toBe(false);
  expect(manifest).toContain('office_pdf:');expect(manifest).toContain('pdf_merge:');
  expect(manifest).not.toMatch(/parametersJsonSchema|"properties"|"required"|"maximum"/u);
});
it('projects all five availability states from real Policy adapters, config, scope, permissions and controls',()=>{
  const t=(name:string)=>catalog.find(t=>t.name===name)!;
  expect(capabilityAvailability(t('media.process'),auth)).toBe('AVAILABLE');
  expect(capabilityAvailability(t('media.collect'),auth)).toBe('AVAILABLE');
  expect(capabilityAvailability(t('media.search'),auth)).toBe('AVAILABLE');
  expect(capabilityAvailability(t('drive.upload'),auth)).toBe('CONFIG_REQUIRED');
  expect(capabilityAvailability(t('minecraft.status'),{...auth,config:{...config,MINECRAFT_ENABLED:false}})).toBe('CONFIG_REQUIRED');
  expect(capabilityAvailability(t('notes.list'),{...auth,chat:{...auth.chat,settings:{modules:{notes:false}}}})).toBe('DISABLED');
  expect(capabilityAvailability(t('minecraft.restart'),{...auth,actor:{id:member,role:'member',groupMember:true}})).toBe('PERMISSION_RESTRICTED');
  expect(capabilityAvailability(t('memory.list'),auth)).toBe('PERMISSION_RESTRICTED');
  expect(capabilityAvailability(t('notes.list'),{...auth,emergency:true})).toBe('DISABLED');
  expect(capabilityAvailability(t('control.reactivate'),{...auth,emergency:true})).toBe('AVAILABLE');
  expect(manifest).toMatch(/media.search:.*;A/u);
  for(const scope of [auth,{...auth,chat:{...auth.chat,settings:{modules:{notes:false,messaging:false}}}}]){
    expect(capabilityManifestV2(catalog,scope).split('\n').filter(l=>/^\w+\.[\w-]+:/u.test(l))).toHaveLength(99);
  }
});
it('keeps the complete manifest compact for every role and chat scope',()=>{
  for(const role of ['owner','group_admin','member'] as const)for(const isGroup of [true,false]){
    const text=capabilityManifestV2(catalog,{...auth,actor:{id:member,role,groupMember:true},chat:{...auth.chat,isGroup}});
    expect(text.length).toBeLessThan(11_000);
    expect(text).not.toMatch(/@|\/home\/|\/data\/|[0-9a-f]{8}-[0-9a-f]{4}/u);
  }
  console.info(`manifest: ${manifest.length} chars; ${Buffer.byteLength(manifest)} UTF-8 bytes; ~${Math.ceil(manifest.length/4)} tokens (heuristic)`);
});
it('loads every public schema in its domain with zero lexical hits, including a full initial window',()=>{
  const modules=[...new Set(catalog.map(t=>t.requiredModule))];
  for(const domain of capabilityDomains){
    const turn=new ToolExposureTurn(catalog,{text:'...',actorRole:'owner',chatType:'group',enabledModules:modules,disableLexicalOptimization:true});
    expect(turn.loadCapability({domain}).status).toBe('ok');
    for(const t of catalog.filter(t=>t.domain===domain && t.llmVisible && adapterAvailable(t.name)))expect(turn.exposure.toolNames).toContain(t.name);
    for(const t of catalog.filter(t=>!adapterAvailable(t.name)))expect(turn.exposure.toolNames).not.toContain(t.name);
    expect(turn.exposure.schemas.length).toBeLessThanOrEqual(product.maxToolsPerTurn);
  }
});
it('sends complete manifest, artifacts, active session and current turn together without backend identifiers',async()=>{
  let old='';
  await context({text:'anterior'},async ctx=>{old=(await backing(ctx,{mime:'image/png',bytes:png})).id;});
  await context({text:'Este botsky'},async ctx=>{
    const current=await backing(ctx);
    await openClarificationV2(ctx.c,'v1_1',{actorId:owner,chatId:chat,pendingTool:'media.process',partialArgs:{operation:'office_pdf'},missingSlots:[{kind:'choice',field:'source',choices:['archivo']}],prompt:'Falta el archivo.',code:'REF_NOT_FOUND',now:ctx.now});
    const snapshot=await buildTurnContextV2(ctx);
    const e=snapshot.envelope;
    expect(e.CAPABILITY_MANIFEST).toContain('office_pdf:');
    expect(e.ARTIFACT_STATE?.CURRENT).toHaveLength(1);
    expect(snapshot.safeRefMap.resolve(e.ARTIFACT_STATE!.CURRENT[0]!.ref,'artifactRef',{actorId:owner,chatId:chat})).toMatchObject({status:'ok',id:current.id});
    expect(e.ARTIFACT_STATE?.RECENT.some(a=>a.mime==='image/png')).toBe(true);
    expect(e.REFERENCE_DATA.activeSession).toMatchObject({pendingTool:'media.process',partialArgs:{operation:'office_pdf'},missingSlots:['source']});
    expect(e.CURRENT_USER_TURN.userText).toBe('Este botsky');
    const text=serializeContextV2(snapshot);
    expect(text).not.toContain(old);expect(text).not.toContain(current.id);
    expect(text).not.toMatch(/@(?:s\.whatsapp|g\.us)|\/home\/|filePath|sha256/u);
  });
});
it('keeps manifest, session and CURRENT/REPLIED under context pressure instead of silently evicting them',async()=>{
  await context({text:'x'.repeat(product.maxTextChars)},async ctx=>{
    await backing(ctx);
    await openClarificationV2(ctx.c,'v1_1',{actorId:owner,chatId:chat,pendingTool:'media.process',partialArgs:{operation:'pdf_crop'},missingSlots:[{kind:'choice',field:'start',choices:['archivo']}],prompt:'¿Qué páginas?',code:'MISSING',now:ctx.now});
    const snapshot=await buildTurnContextV2(ctx);
    snapshot.envelope.REFERENCE_DATA.notes=Array.from({length:5},()=>({ref:'noteRef_fake' as const,text:'z'.repeat(4000)}));
    const bounded=budgetContextV2(snapshot.envelope);
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(bounded.CAPABILITY_MANIFEST).toBe(snapshot.envelope.CAPABILITY_MANIFEST);
    expect(bounded.REFERENCE_DATA.activeSession?.pendingTool).toBe('media.process');
    expect(bounded.ARTIFACT_STATE?.CURRENT).toHaveLength(1);
    expect(bounded.CURRENT_USER_TURN.userText.length).toBe(product.maxTextChars);
  });
});
it('delivers complete knowledge to the actual router without loading all schemas or claiming a queued result was delivered',async()=>{
  await context({text:'hazlo stoker'},async ctx=>{
    await backing(ctx,{mime:'image/png',bytes:png});
    let providerAssertion:unknown;
    const output=await routeNaturalV2(ctx,{generate:async input=>{
      try {
      const e=JSON.parse((input.contents[0] as {parts:{text:string}[]}).parts[0]!.text) as {CAPABILITY_MANIFEST:string};
      expect(e.CAPABILITY_MANIFEST).toContain('minecraft.addons:');
      expect(e.CAPABILITY_MANIFEST).toContain('qr_read:');
      expect(input.tools.length).toBeLessThanOrEqual(20);
      expect(input.system).toContain(capabilityBehaviorV2);
      expect(JSON.stringify(input).length).toBeLessThan(product.llmMaxRequestChars);
      } catch(error) { providerAssertion=error; throw error; }
      if(!input.tools.some(t=>t.name==='media_process'))return {text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:'core_load_capability',args:{domain:'media',toolName:'media.process'}}}]}};
      return {text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:'media_process',args:{operation:'sticker',artifactRef:'A_CURRENT'}}}]}};
    }});
    if(providerAssertion)throw providerAssertion;
    expect(output ?? '').not.toMatch(/ya.*(?:entreg|envi)/iu);
    expect((await ctx.c.query("SELECT status,payload->>'operation' operation FROM jobs WHERE kind='media'")).rows).toEqual([{status:'queued',operation:'sticker'}]);
  });
});
it('keeps the full request within the existing provider budget for a school request',async()=>{
  await context({text:'qué materias tengo en la escuela'},async ctx=>{
    const snapshot=await buildTurnContextV2(ctx,['school']);
    const turn=new ToolExposureTurn(catalog,{text:ctx.msg.text,actorRole:'owner',chatType:'group',enabledModules:snapshot.runtime.enabledModules});
    const request={system:naturalRouterSystemV2(turn),contents:[{role:'user',parts:[{text:serializeContextV2(snapshot)}]}],tools:[]};
    turn.fitSchemaBudget(product.llmMaxRequestChars-JSON.stringify(request).length+2);
    expect(JSON.stringify({...request,tools:turn.exposure.schemas}).length).toBeLessThanOrEqual(product.llmMaxRequestChars);
    expect(turn.exposure.toolNames).toContain('core.load_capability');
  });
});

it('does not force a business effect after discovery when a bounded retry loaded schemas but found no compatible output',async()=>{
  let attempt=0;
  await context({text:'convierte el documento a un formato no soportado'},async ctx=>{
    const output=await routeNaturalV2(ctx,{generate:async input=>{
      attempt++;
      if(attempt===1)return {text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'action_required',text:'Necesito consultar la capacidad.',effects:[]})}]}};
      if(attempt===2){expect(input.requireFunctionCall).toBeUndefined();return {text:'',calls:[],content:{role:'model',parts:[{functionCall:{name:'core_load_capability',args:{domain:'media'}}}]}};}
      expect(input.requireFunctionCall).toBeUndefined();
      expect(input.validateFunctionCalls).toBe(true);
      const initial=(input.contents[0] as {parts:{text:string}[]}).parts[0]!.text;
      expect(initial).toContain('"CAPABILITY_MANIFEST":');
      expect(JSON.stringify(input.contents.slice(1))).not.toContain('"CAPABILITY_MANIFEST":');
      return {text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'unavailable',capability:{toolName:'media.process',outputFormat:'docx'},text:'Esa conversión no está disponible.',effects:[]})}]}};
    }});
    expect(output).toBe('Esa conversión no está disponible.');
    expect((await ctx.c.query('SELECT 1 FROM jobs')).rowCount).toBe(0);
    expect(attempt).toBe(3);
  });
});

it('fits actual large current turns by rotating schemas while keeping complete knowledge and discovery',async()=>{
  await context({text:'escuela '.repeat(490)},async ctx=>{
    const output=await routeNaturalV2(ctx,{generate:async input=>{
      expect(JSON.stringify(input).length).toBeLessThanOrEqual(product.llmMaxRequestChars);
      expect(input.tools.map(t=>t.name)).toContain('core_load_capability');
      expect(JSON.stringify(input.contents)).toContain('school.summary_configure:');
      expect(JSON.stringify(input.contents)).toContain('minecraft.console:');
      return {text:'',calls:[],content:{role:'model',parts:[{text:JSON.stringify({outcome:'conversation',text:'¿Qué necesitas de la escuela?',effects:[]})}]}};
    }});
    expect(output).toBe('¿Qué necesitas de la escuela?');
  });
});

it('reports received but unretained attachments honestly without inventing SafeRefs or silently using an old file',async()=>{
  await context({text:'anterior'},ctx=>backing(ctx,{mime:'image/png',bytes:png}));
  await context({text:'procesa las dos',attachments:[{kind:'image',ref:'one',mime:'image/jpeg'},{kind:'image',ref:'two',mime:'image/jpeg'}]},async ctx=>{
    const e=(await buildTurnContextV2(ctx)).envelope;
    expect(e.ARTIFACT_STATE?.CURRENT).toEqual([]);
    expect(e.ARTIFACT_STATE?.UNRETAINED_CURRENT).toEqual([
      {kind:'image',mime:'image/jpeg',status:'SOURCE_NOT_RETAINED'},
      {kind:'image',mime:'image/jpeg',status:'SOURCE_NOT_RETAINED'},
    ]);
    expect(e.ARTIFACT_STATE?.RECENT).toHaveLength(1);
    expect(e.ARTIFACT_STATE?.UNRETAINED_CURRENT?.some(a=>'ref' in a)).toBe(false);
  });
});
