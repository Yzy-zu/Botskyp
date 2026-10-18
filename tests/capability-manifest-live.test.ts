import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import { db, initialize, reset, context, backing, config, owner, png } from './r4-harness.js';
import { readConfig } from '../src/config.js';
import { Gemini, type LlmInput } from '../src/core/llm.js';
import { buildTurnContextV2, serializeContextV2 } from '../src/core/context-v2.js';
import { ToolExposureTurn } from '../src/core/tool-exposure.js';
import { createToolRegistryV2 } from '../src/core/tool-registry-v2.js';
import { createRegistry } from '../src/core/registry.js';
import { naturalRouterSystemV2, routeNaturalV2 } from '../src/core/router-v2.js';
import { geminiToolContext, geminiContentSchema, geminiFunctionResult } from '../src/core/provider-tool-context.js';
import { SafeRefs } from '../src/core/safe-refs.js';
import { openClarificationV2 } from '../src/core/sessions-v2.js';
import { product } from '../config/product.js';
import { currentFunctionProtocolV2 } from '../src/core/capability-manifest-v2.js';
import { conversationTextV2 } from '../src/core/composer-v2.js';
import type { ToolCtx } from '../src/core/tools.js';

process.loadEnvFile('.env');
const runLive=process.env.BOTSKY_MANIFEST_LIVE==='1';
const live=readConfig({...process.env,DATABASE_URL:config.DATABASE_URL,TRANSPORT:'mock',OWNER_JIDS:owner,LAB_CHAT_ID:config.LAB_CHAT_ID,ROUTER_MODE:'v1_1',ROUTER_V1_1_CHAT_IDS:undefined});
const catalog=createToolRegistryV2(createRegistry());
type Case={label:string;text:string;input:'images'|'image'|'pdf'|'pdfs'|'audio'|'none';tool?:string;operation?:string;unavailable?:boolean;domain?:string;session?:boolean};
const cases:Case[]=[
  {label:'A',text:'botsky haz estas foto pidief',input:'images',operation:'images_pdf'},
  {label:'B',text:'pasame este a wordsito',input:'pdf',unavailable:true},
  {label:'C',text:'hazlo stoker',input:'image',operation:'sticker'},
  {label:'D',text:'q onda el maikrasito',input:'none',domain:'minecraft'},
  {label:'E',text:'dame lo gratis q toca cada dia',input:'none',tool:'xp.daily'},
  {label:'F',text:'lee ese cuadrito raro de la foto',input:'image',operation:'qr_read'},
  {label:'G',text:'junta estos documentos',input:'pdfs',operation:'pdf_merge'},
  {label:'H',text:'que dice este audio',input:'audio',operation:'transcribe'},
  {label:'adapter',text:'busca música de Beethoven',input:'none',unavailable:true},
  {label:'session',text:'Este botsky',input:'pdf',operation:'pdf_compress',session:true},
];
// New phrases are supplied at execution time from an ignored local artifact, not stored fixtures.
const fresh:Case[]=runLive && existsSync('.local/manifest-fresh-inputs.json')?JSON.parse(readFileSync('.local/manifest-fresh-inputs.json','utf8')) as Case[]:[];
const reports:Record<string,unknown>[]=[];
let lastCall=0;
async function paced(provider:Gemini,input:LlmInput){
  const delay=6500-(Date.now()-lastCall);
  if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
  lastCall=Date.now();
  return provider.generate({...input,validateFunctionCalls:true});
}
beforeAll(initialize);beforeEach(reset);afterAll(async()=>{
  vi.restoreAllMocks();
  if(runLive)writeFileSync('.local/capability-manifest-live.json',JSON.stringify(reports,null,2),{mode:0o600});
  await db.end();
});

/** Real Gemini + production manifest/system/exposure. Proposals only; no external handler effects. */
async function discover(ctx:ToolCtx,scenario:Case){
  const snapshot=await buildTurnContextV2(ctx);
  const count=['images','pdfs'].includes(scenario.input)?2:scenario.input==='none'?0:1;
  const mime=scenario.input.startsWith('image')?'image/png':scenario.input==='audio'?'audio/ogg':'application/pdf';
  const refs=new SafeRefs(Array.from({length:count},(_,index)=>({kind:'artifactRef' as const,id:`fixture-${index}`,chatId:ctx.chat.id,label:mime,access:{visibility:'personal' as const,ownerId:ctx.actor.id}})));
  const artifacts=refs.list({chatId:ctx.chat.id,actorId:ctx.actor.id}).map(r=>({ref:r.ref,mime,kind:mime.startsWith('application/')?'document':mime.split('/')[0]!}));
  // Synthetic attachment state tests the multi-file model contract; baseline ingestion still dedupes by message/kind.
  snapshot.envelope.ARTIFACT_STATE={CURRENT:artifacts,REPLIED:null,RECENT:[],A_LAST:artifacts[0]?{...artifacts[0],ref:'A_LAST'}:null};
  const turn=new ToolExposureTurn(catalog,{text:scenario.text,actorRole:'owner',chatType:'group',enabledModules:snapshot.runtime.enabledModules,...(scenario.session?{activeSession:{domain:'media' as const,kind:'clarify' as const,pendingTool:'media.process'}}:{}),disableLexicalOptimization:true});
  const provider=new Gemini(db,live,owner);
  const contents:unknown[]=[{role:'user',parts:[{text:serializeContextV2(snapshot)},...(scenario.label==='F' && existsSync('tests/fixtures/manifest-qr.png')?[{inlineData:{mimeType:'image/png',data:readFileSync('tests/fixtures/manifest-qr.png').toString('base64')}}]:[])]}];
  const proposals:{name:string;args:Record<string,unknown>}[]=[];
  let answer='',expansions=0,maxSchemas=0,maxRequest=0,retries=0;
  for(let attempt=0;attempt<product.llmMaxCalls;attempt++){
    const request:LlmInput={system:naturalRouterSystemV2(turn)+'\n'+currentFunctionProtocolV2(turn.exposure.schemas.map(t=>t.name)),contents:structuredClone(contents),tools:[...turn.exposure.schemas]};
    const overhead=JSON.stringify({...request,tools:[]},(key,value:unknown)=>key==='data'?'[image]':value).length-2;
    turn.fitSchemaBudget(product.llmMaxRequestChars-overhead);request.tools=[...turn.exposure.schemas];
    maxSchemas=Math.max(maxSchemas,request.tools.length);
    maxRequest=Math.max(maxRequest,JSON.stringify(request,(key,value:unknown)=>key==='data'?'[image]':value).length);
    const output=await paced(provider,request), model=geminiToolContext(geminiContentSchema.parse(output.content));
    contents.push(model.modelContent);
    if(!model.calls.length){
      answer=model.modelContent.parts.map(p=>p.text ?? '').join('');
      if(conversationTextV2(answer).retry && retries===0){
        retries++;contents.push({role:'user',parts:[{text:'El usuario pidió una acción. Usa una función nativa declarada, empezando por core_load_capability si falta el schema. Nunca escribas llamadas en effects. Si no existe la capacidad, explica la limitación real.'}]});continue;
      }
      break;
    }
    let expanded=false;
    for(const {call} of model.calls){
      expect(request.tools.map(t=>t.name)).toContain(call.name);
      proposals.push({name:catalog.find(t=>t.name.replaceAll('.','_').replaceAll('-','_')===call.name)?.name ?? call.name.replaceAll('_','.'),args:call.args as Record<string,unknown>});
      if(call.name==='core_load_capability'){
        expect(turn.loadCapability(call.args).status).toBe('ok');expansions++;expanded=true;
        contents.push({role:'user',parts:[geminiFunctionResult(call,{status:'ok',message:'Schemas cargados. Comprueba que la operación produce la salida pedida; si no existe, explica la limitación sin ejecutar alternativas.'})]});
      }
    }
    if(!expanded)break;
  }
  const record={label:scenario.label,text:scenario.text,proposals,answer,expansions,maxSchemas,maxRequest,providerCalls:provider.counters.calls,inputTokens:provider.counters.inputTokens,outputTokens:provider.counters.outputTokens};
  reports.push(record);console.info('[manifest real]',JSON.stringify(record));
  return record;
}

it.runIf(runLive).each([...cases,...fresh])('Gemini real with ZERO lexical optimization: $label',async scenario=>{
  await context({text:scenario.text},async ctx=>{
    if(scenario.session)await openClarificationV2(ctx.c,'v1_1',{actorId:owner,chatId:ctx.chat.id,pendingTool:'media.process',partialArgs:{operation:'pdf_compress'},missingSlots:[{kind:'choice',field:'source',choices:['archivo']}],prompt:'Falta el PDF.',code:'REF_NOT_FOUND',now:ctx.now});
    const result=await discover({...ctx,config:live},scenario);
    expect(result.maxSchemas).toBeLessThanOrEqual(20);
    expect(result.maxRequest).toBeLessThanOrEqual(product.llmMaxRequestChars);
    expect(result.expansions).toBeLessThanOrEqual(1);
    if(scenario.operation)expect(result.proposals.some(p=>p.name==='media.process' && p.args.operation===scenario.operation || p.name==='media.collect' && p.args.operation===scenario.operation)).toBe(true);
    if(scenario.tool)expect(result.proposals.some(p=>p.name===scenario.tool)).toBe(true);
    if(scenario.domain){expect(result.expansions).toBe(1);expect(result.proposals.some(p=>p.name.startsWith(`${scenario.domain}.`))).toBe(true);}
    if(scenario.unavailable){
      expect(result.proposals.filter(p=>p.name!=='core.load.capability')).toEqual([]);
      expect(result.answer).toMatch(/disponible|no (?:tengo|puedo|está)|no.*(?:conectad|soport)|deshabilitad/iu);
      if(scenario.label==='B')expect(result.answer).toMatch(/Word|DOCX/iu);
      if(scenario.label==='adapter')expect(result.answer).toMatch(/conectad|integraci[oó]n|conexi[oó]n|funci[oó]n.*no.*disponible/iu);
      expect(result.answer).not.toMatch(/no entend[ií]|qu[eé] quieres hacer|qu[eé] archivo/iu);
    }
  });
},60000);

it.runIf(runLive)('Gemini real through production router and Policy: sticker enqueued and daily persisted; no delivery claims',async()=>{
  await context({text:'hazlo stoker'},async ctx=>{
    await backing(ctx,{mime:'image/png',bytes:png});
    const provider=new Gemini(db,live,owner);
    const result=await routeNaturalV2({...ctx,config:live},{generate:input=>paced(provider,input)});
    expect(result ?? '').not.toMatch(/ya.*(?:envi|entreg)/iu);
    expect((await ctx.c.query("SELECT status,payload->>'operation' operation FROM jobs WHERE kind='media'")).rows).toEqual([{status:'queued',operation:'sticker'}]);
    reports.push({label:'router-sticker',queued:true,delivered:false});
  });
  await context({text:'dame lo gratis q toca cada dia'},async ctx=>{
    const provider=new Gemini(db,live,owner);
    const result=await routeNaturalV2({...ctx,config:live},{generate:input=>paced(provider,input)});
    expect(result).toContain('premio diario');
    expect((await ctx.c.query("SELECT 1 FROM tool_executions WHERE tool_name='xp.daily' AND status='ok'")).rowCount).toBe(1);
    reports.push({label:'router-daily',persisted:true});
  });
},60000);

it.runIf(runLive)('Gemini real completes a pending media source with a CURRENT file through the production router',async()=>{
  await context({text:'Este botsky'},async ctx=>{
    await backing(ctx);
    await openClarificationV2(ctx.c,'v1_1',{actorId:owner,chatId:ctx.chat.id,pendingTool:'media.process',partialArgs:{operation:'pdf_compress'},missingSlots:[{kind:'choice',field:'source',choices:['archivo']}],prompt:'Falta el PDF.',code:'REF_NOT_FOUND',now:ctx.now});
    const provider=new Gemini(db,live,owner);
    const result=await routeNaturalV2({...ctx,config:live},{generate:input=>paced(provider,input)});
    expect(result ?? '').not.toMatch(/ya.*(?:envi|entreg)/iu);
    expect((await ctx.c.query("SELECT status,payload->>'operation' operation FROM jobs WHERE kind='media'")).rows).toEqual([{status:'queued',operation:'pdf_compress'}]);
    reports.push({label:'router-session-source',queued:true,operation:'pdf_compress',delivered:false});
  });
},60000);

it.runIf(runLive)('Gemini real through production router explains unavailable requested output without executing an alternative',async()=>{
  await context({text:'pasame este a wordsito'},async ctx=>{
    await backing(ctx);
    const provider=new Gemini(db,live,owner);
    const result=await routeNaturalV2({...ctx,config:live},{generate:input=>paced(provider,input)});
    expect(result).toMatch(/Word|DOCX/iu);
    expect(result).toMatch(/no (?:puedo|tengo)|no.*disponible|no.*conversi[oó]n/iu);
    expect((await ctx.c.query("SELECT 1 FROM jobs WHERE kind='media'")).rowCount).toBe(0);
    reports.push({label:'router-unavailable-output',reply:result,alternativeExecuted:false});
  });
},60000);
