import { verifiedLimitationV2 } from './capability-truth-v2.js';
import { loadArtifactContextV2 } from './artifact-context-v2.js';
import { currentResultV2 } from './current-result-v2.js';
import { product } from '../../config/product.js';
import pino from 'pino';
import { z } from 'zod';
import type { ToolCtx } from './tools.js';
import type { Llm, Image, LlmReply } from './llm.js';
import { LlmUnavailable } from './llm.js';
import type { ToolMetadataV2 } from './tool-registry-v2.js';
import { backendOnlyFields, modelDeclaration } from './tool-registry-v2.js';
import type { TurnContextV2 } from './context-v2.js';
import { buildTurnContextV2, serializeContextV2 } from './context-v2.js';
import type { ToolExposureTurn } from './tool-exposure.js';
import { geminiContentSchema, geminiToolContext, geminiFunctionResult } from './provider-tool-context.js';
import { executeToolV2, evaluateToolV2 } from './policy-v2/executor.js';
import { continueConfirmationV2 } from './session-confirmation-v2.js';
import { cancelSessionV2 } from './sessions-v2.js';
import { executionTransaction } from './execution-transaction-v2.js';
import type { ToolResult } from './tool-result.js';
import { localPresenterV2, visibleToolResultV2, conversationTextV2, conversationalOutcomeV2 } from './composer-v2.js';
import { currentFunctionProtocolV2 } from './capability-manifest-v2.js';

export type RouterMetricsV2={callsPerTurn:number;inputTokens:number;outputTokens:number;toolCount:number;capabilityExpansion:number;synthesisUsed:boolean;mutationRetry:number;routerLatency:number;backendFieldAttempts:number;capability_truth_retry?:boolean};
const retryInstruction='Revisa la intención y la salida solicitada contra CAPABILITY_MANIFEST y los schemas. Si existe una operación compatible, usa la función nativa o carga su dominio primero. Si no existe o está indisponible, responde outcome=unavailable con la limitación real, sin tools ni alternativas ejecutadas. Para unavailable incluye capability={toolName,operation u outputFormat} como evidencia estructurada contra el Manifest. No simules llamadas en effects ni afirmes efectos sin tool.';
const log=pino({level:'info'});
const synthesisSchema=z.toJSONSchema(conversationalOutcomeV2);
delete synthesisSchema.$schema;
const emptyArgsSchema=z.strictObject({});
function backendAttempts(args:unknown):number{
  if(!args || typeof args!=='object')return 0;
  return Object.entries(args).reduce((sum,[k,v])=>sum+((backendOnlyFields as readonly string[]).some(f=>f.toLowerCase()===k.toLowerCase())?1:0)+backendAttempts(v),0);
}
function providerFailure(error:unknown):string{
  if(error instanceof LlmUnavailable && error.kind==='blocked')return 'Gemini bloqueó esa solicitud por sus propias restricciones. No pude completarla.';
  if(error instanceof LlmUnavailable && ['quota','local_limit'].includes(error.kind))return 'Llegué al límite de IA por ahora. Inténtalo más tarde.';
  return 'La IA no pudo responder en este momento. Inténtalo más tarde.';
}
/** All provider content exists only inside this logical turn. Historical context never becomes executable contents. */
export async function naturalToolLoopV2(ctx:ToolCtx,llm:Llm,catalog:readonly ToolMetadataV2[],initial:TurnContextV2,exposure:ToolExposureTurn,system:string,userText:string,images:Image[],metrics:RouterMetricsV2):Promise<string>{
  const initialCounters=llm.counters?{...llm.counters}:undefined;
  let context=initial;
  const contents:unknown[]=[{role:'user',parts:[{text:userText},...images.map(inlineData=>({inlineData}))]}];
  const results:ToolResult[]=[];
  const providerCallIds=new Set<string>();
  const deliveredArtifactRefs=new Set<string>();
  const rememberDeliveredArtifacts=()=>{
    const state=context.envelope.ARTIFACT_STATE;
    for(const item of [...(state?.CURRENT ?? []),...(state?.RECENT ?? []),...(state?.REPLIED?[state.REPLIED]:[]),...(state?.A_LAST?[state.A_LAST]:[])])deliveredArtifactRefs.add(item.ref);
  };
  rememberDeliveredArtifacts();
  let stopped=false;
  const local=()=>results.map(localPresenterV2).filter(Boolean).join('\n\n');
  async function generate(synthesis=false):Promise<LlmReply>{
    if(metrics.callsPerTurn>=product.llmMaxCalls)throw new LlmUnavailable('local_limit','message');
    metrics.callsPerTurn++;
    const protocol=synthesis?'':`\n${currentFunctionProtocolV2(exposure.exposure.schemas.map(t=>t.name))}`;
    const request={...(ctx.turnId?{turnId:ctx.turnId}:{}),...(synthesis?{responseJsonSchema:synthesisSchema}:{validateFunctionCalls:true}),system:system+(synthesis?'\nEsta vuelta solo sintetiza los resultados visibles. Si status=needs_clarification, formula una pregunta breve para missingSlots; no afirmes ninguna acción. Contesta la pregunta con fuentes disponibles. No solicites acciones nuevas. Usa el mismo JSON de outcome sin effects.':protocol),contents:structuredClone(contents),tools:synthesis?[]:[...exposure.exposure.schemas]};
    if(!synthesis){
      // Same accounting as the REST adapter: binary data is not prompt text.
      const overhead=JSON.stringify({...request,tools:[]},(key,value:unknown)=>key==='data'?'[image]':value).length-2;
      exposure.fitSchemaBudget(product.llmMaxRequestChars-overhead);
      request.tools=[...exposure.exposure.schemas];
      request.system=system+`\n${currentFunctionProtocolV2(request.tools.map(t=>t.name))}`;
    }
    const reply=await llm.generate(request);
    metrics.inputTokens+=reply.usage?.inputTokens ?? 0;metrics.outputTokens+=reply.usage?.outputTokens ?? 0;
    return reply;
  }
  try{
    while(metrics.callsPerTurn<product.llmMaxCalls){
      const output=await generate();
      const parsed=geminiContentSchema.safeParse(output.content);
      if(!parsed.success)throw new LlmUnavailable('invalid');
      const provider=geminiToolContext(parsed.data);
      // Use original content with all parts/signatures, never rebuild {name,args} into a new model part.
      contents.push(provider.modelContent);
      if(!provider.calls.length){
        if(results.length)return local();
        const text=provider.modelContent.parts.filter(p=>!p.thought).map(p=>p.text ?? '').join('');
        const outcome=conversationTextV2(text);
        const invalidLimitation=outcome.outcome==='unavailable' && !await verifiedLimitationV2(ctx,context,catalog,outcome.capability);
        if((outcome.retry || invalidLimitation) && !metrics.capability_truth_retry && metrics.mutationRetry<product.maxMutationRetriesPerTurn && metrics.callsPerTurn<product.llmMaxCalls){
          metrics.mutationRetry++;contents.push({role:'user',parts:[{text:retryInstruction}]});continue;
        }
        return invalidLimitation?'No pude verificar esa limitación con las capacidades disponibles. Inténtalo de nuevo.':outcome.text;
      }
      const responses:ReturnType<typeof geminiFunctionResult>[]=[];
      let expanded=false;
      const loadedImages:Image[]=[];
      for(const {call} of provider.calls){
        // Every proposed call, including failed/unknown/meta calls, consumes a hard slot.
        if(metrics.toolCount>=product.maxToolCallsPerTurn){stopped=true;responses.push(geminiFunctionResult(call,{status:'denied',message:'Se alcanzó el límite de acciones del turno.'}));continue;}
        metrics.toolCount++;
        if(call.id!==undefined){
          if(providerCallIds.has(call.id)){
            const duplicate:ToolResult={toolName:'core.duplicate',domain:'core',status:'denied',code:'DUPLICATE_PROVIDER_CALL',data:{}};
            results.push(duplicate);responses.push(geminiFunctionResult(call,visibleToolResultV2(duplicate)));continue;
          }
          providerCallIds.add(call.id);
        }
        metrics.backendFieldAttempts+=backendAttempts(call.args);
        if(call.name==='core_load_capability' || call.name==='core.load_capability'){
          const expansion=exposure.loadCapability(call.args);
          if(expansion.status==='ok'){
            metrics.capabilityExpansion++;expanded=true;
            const updated=await buildTurnContextV2(ctx,exposure.exposure.relevantDomains);
            updated.safeRefMap.include(context.safeRefMap);context=updated;
          }
          if(expansion.status!=='ok')results.push({toolName:'core.load_capability',domain:'core',status:'denied',code:'DENIED_CAPABILITY_EXPANSION',data:{}});
          const delta=JSON.parse(serializeContextV2(context)) as Record<string,unknown>;
          // The complete manifest is already in the first turn message. Do not duplicate it on expansion.
          delete delta.CAPABILITY_MANIFEST;
          delete delta.CURRENT_USER_TURN;
          delete delta.SYSTEM_RULES;
          responses.push(geminiFunctionResult(call,{status:expansion.status,message:expansion.status==='ok'?'Schemas cargados. Comprueba que la operación produce la salida pedida; si no existe, explica la limitación sin ejecutar alternativas.':'No puedo ampliar esa capacidad en este turno.',...(expansion.status==='ok'?{context:delta}:{})}));
          continue;
        }
        if(call.name==='core_load_artifact_context' || call.name==='core.load_artifact_context'){
          const ref=call.args && typeof call.args==='object'?(call.args as Record<string,unknown>).artifactRef:undefined;
          const loaded:{status:string;image?:Image;artifactRef?:string}=typeof ref==='string' && deliveredArtifactRefs.has(ref)?await loadArtifactContextV2(ctx,context.safeRefMap,call.args):{status:'REF_NOT_DELIVERED'};
          responses.push(geminiFunctionResult(call,{status:loaded.status,...(loaded.artifactRef?{artifactRef:loaded.artifactRef}:{})}));
          if(loaded.image)loadedImages.push(loaded.image);
          expanded=true;
          continue;
        }
        if(call.name==='core_session_confirm' || call.name==='core.session_confirm'){
          if(!exposure.exposure.toolNames.includes('core.session_confirm') || !emptyArgsSchema.safeParse(call.args ?? {}).success){
            const denied:ToolResult={toolName:'core.session_confirm',domain:'core',status:'denied',code:!emptyArgsSchema.safeParse(call.args ?? {}).success?'INVALID_MODEL_ARGUMENTS':'DENIED_TOOL_NOT_EXPOSED',data:{}};
            results.push(denied);responses.push(geminiFunctionResult(call,visibleToolResultV2(denied)));continue;
          }
          const confirmed=await continueConfirmationV2(ctx,context.safeRefMap);
          const res:ToolResult='toolName' in confirmed?await currentResultV2(ctx,confirmed):{toolName:'core.session_confirm',domain:'core',status:'denied',code:confirmed.status==='expired'?'DENIED_CONFIRMATION_EXPIRED':'SESSION_NOT_FOUND',data:{}};
          results.push(res);responses.push(geminiFunctionResult(call,visibleToolResultV2(res)));continue;
        }
        if(call.name==='core_session_cancel' || call.name==='core.session_cancel'){
          if(!exposure.exposure.toolNames.includes('core.session_cancel') || !emptyArgsSchema.safeParse(call.args ?? {}).success){
            const denied:ToolResult={toolName:'core.session_cancel',domain:'core',status:'denied',code:!emptyArgsSchema.safeParse(call.args ?? {}).success?'INVALID_MODEL_ARGUMENTS':'DENIED_TOOL_NOT_EXPOSED',data:{}};
            results.push(denied);responses.push(geminiFunctionResult(call,visibleToolResultV2(denied)));continue;
          }
          const status=await executionTransaction(ctx,c=>cancelSessionV2(c,ctx.config.ROUTER_MODE,context.runtime.actor.id,context.runtime.chat.id,ctx.now));
          const res:ToolResult=status==='cancelled'?{toolName:'core.session_cancel',domain:'core',status:'ok',code:'SESSION_CANCELLED',data:{}}:
            {toolName:'core.session_cancel',domain:'core',status:'denied',code:status==='expired'?'DENIED_CONFIRMATION_EXPIRED':'SESSION_NOT_FOUND',data:{}};
          results.push(res);responses.push(geminiFunctionResult(call,visibleToolResultV2(res)));continue;
        }
        const tool=catalog.find(t=>t.llmVisible && (t.name===call.name || modelDeclaration(t).name===call.name));
        const exposed=tool && exposure.exposure.toolNames.includes(tool.name);
        if(!tool || !exposed){
          const policy=tool?await evaluateToolV2(ctx,tool.name,call.args ?? {},{callOrigin:'llm',safeRefMap:context.safeRefMap,...(call.id?{providerCallId:call.id}:{}),toolExposureCount:exposure.exposure.schemas.length}):undefined;
          if(tool && policy && ['allow','needs_confirmation','needs_clarification'].includes(policy.status)){
            responses.push(geminiFunctionResult(call,{status:'schema_not_loaded',domain:tool.domain,next:'core_load_capability'}));
            expanded=true;continue;
          }
          const denied:ToolResult={toolName:tool?.name ?? 'core.unknown',domain:tool?.domain ?? 'core',status:'denied',code:policy?.denialCode ?? 'DENIED_TOOL_NOT_EXPOSED',data:{}};
          log.info({routerOutcome:tool?'tool_not_exposed':'tool_not_found',turnId:ctx.turnId},'Natural router unavailable tool');
          results.push(denied);responses.push(geminiFunctionResult(call,visibleToolResultV2(denied)));continue;
        }
        if(call.id===''){responses.push(geminiFunctionResult(call,{status:'denied',message:'La solicitud no es válida.'}));continue;}
        // Strict model schema is revalidated by Policy before any trusted identity/args are constructed.
        const executed=await executeToolV2(ctx,tool.name,call.args ?? {},{callOrigin:'llm',safeRefMap:context.safeRefMap,...(call.id===undefined?{}:{providerCallId:call.id}),toolExposureCount:exposure.exposure.schemas.length});
        const result=await currentResultV2(ctx,executed);
        if(result.toolName==='school.schedule_import' && result.status==='ok')expanded=true;
        results.push(result);responses.push(geminiFunctionResult(call,visibleToolResultV2(result)));
      }
      contents.push({role:'user',parts:[...responses,...loadedImages.map(inlineData=>({inlineData}))]});
      rememberDeliveredArtifacts();
      if(stopped)break;
      if(expanded){if(metrics.toolCount>=product.maxToolCallsPerTurn)break;continue;}
      if(results.length && results.every(r=>r.status==='needs_clarification' && !['AMBIGUOUS_HOUR','MISSING_DATE'].includes(r.code)) && metrics.callsPerTurn<product.llmMaxCalls){
        metrics.synthesisUsed=true;
        const clarified=await generate(true);
        const content=geminiContentSchema.safeParse(clarified.content);
        if(content.success && !geminiToolContext(content.data).calls.length){
          const answer=conversationTextV2(content.data.parts.filter(p=>!p.thought).map(p=>p.text ?? '').join(''));
          if(answer.valid && !answer.retry)return answer.text;
        }
        return local();
      }
      // Deterministic/mutating results never need another provider call to report success.
      const onlyReads=results.every(r=>catalog.find(t=>t.name===r.toolName)?.risk==='READ' || r.toolName==='web.search');
      const protectedEconomy=results.some(r=>['economy','games','library'].includes(r.domain));
      const synthesis=onlyReads && !protectedEconomy && results.every(r=>r.status==='ok') && (results.some(r=>r.requiresLlmSynthesis) || results.length>1);
      if(!synthesis)return local();
      if(metrics.callsPerTurn>=product.llmMaxCalls)break;
      metrics.synthesisUsed=true;
      const summary=await generate(true);
      const content=geminiContentSchema.safeParse(summary.content);
      // Synthesis is read-only even if the provider violates the no-tools request.
      if(content.success && !geminiToolContext(content.data).calls.length){
        const answer=conversationTextV2(content.data.parts.filter(p=>!p.thought).map(p=>p.text ?? '').join(''));
        if(!answer.retry && answer.valid)return answer.text;
      }
      return local();
    }
    return `${local()}${results.length?'\n\n':''}Llegué al límite de acciones de esta solicitud. Lo que falte, pídemelo en otro mensaje.`;
  }catch(error){
    log.info({routerOutcome:error instanceof LlmUnavailable?(error.kind==='blocked'?'provider_blocked':'technical_failure'):'technical_failure',reason:error instanceof LlmUnavailable?error.kind:'internal',turnId:ctx.turnId},'Natural router failure');
    return results.length?local():providerFailure(error);
  }
  finally{
    if(llm.counters && initialCounters){metrics.callsPerTurn=llm.counters.calls-initialCounters.calls;metrics.inputTokens=llm.counters.inputTokens-initialCounters.inputTokens;metrics.outputTokens=llm.counters.outputTokens-initialCounters.outputTokens;}
  }
}
