import { z } from 'zod';
import { product } from '../../config/product.js';
import { artifactsForTurn } from './chat-artifacts.js';
import { artifactCompatible } from './artifact-resolution-v2.js';
import { openCollectionSessionV2, readSessionV2, decideSessionV2, type SessionV2 } from './sessions-v2.js';
import { SafeRefs } from './safe-refs.js';
import { executeToolV2 } from './policy-v2/executor.js';
import { executionTransaction } from './execution-transaction-v2.js';
import { prepareArtifactsV2 } from './prepare-artifacts-v2.js';
import { ok, fail, type ToolCtx } from './tools.js';
import type { ExecutionContextV2, PolicyDecision } from './policy-v2/types.js';
import type { ToolResult } from './tool-result.js';
import { localPresenterV2 } from './composer-v2.js';

const collection=z.strictObject({operation:z.enum(['images_pdf','pdf_merge']),artifactIds:z.array(z.uuid()).max(product.mediaMaxFiles)});
async function currentFiles(ctx: ToolCtx, operation: 'images_pdf'|'pdf_merge') {
  const files=await artifactsForTurn(ctx.c,{chatId:ctx.chat.id,actorId:ctx.actor.id,sourceMessageId:ctx.msg.id,now:ctx.now});
  return files.current.filter(a=>a.actor_id===ctx.actor.id && artifactCompatible(operation,a));
}
/** Start only inside executor after the existing chat/module/permission gates. */
export async function beginCollectionV2(ctx: ExecutionContextV2, decision: PolicyDecision) {
  const operation=z.enum(['images_pdf','pdf_merge']).parse(decision.resolvedArgs.operation);
  if(decision.resolvedArgs.action==='finish'){
    const session=await readSessionV2(ctx.legacy.c,ctx.actorId,ctx.chatId);
    if(!session || session.kind!=='media_collect' || session.expires_at<=ctx.now)return fail('No hay una colección abierta. Pídeme reunir las fotos o PDF primero.');
    if(collection.parse(session.partial_args).operation!==operation)return fail('La colección abierta es de otro tipo de archivo. Termínala o cancélala primero.');
    const result=await continueCollectionV2({...ctx.legacy,inboxTransaction:true},session,true);
    if(typeof result==='string')return fail(result);
    if(result?.status==='queued')return ok('',result.data as Record<string,unknown>);
    return fail(result?localPresenterV2(result):'No pude cerrar esa colección.');
  }
  const files=await currentFiles(ctx.legacy,operation);
  if(ctx.legacy.msg.attachments.length && !files.length)return fail(operation==='images_pdf'?'Envíame fotos para hacer el PDF.':'Envíame archivos PDF para unirlos.');
  const active=await readSessionV2(ctx.legacy.c,ctx.actorId,ctx.chatId);
  if(active?.kind==='media_collect' && active.expires_at>ctx.now){
    const state=collection.parse(active.partial_args);
    if(state.operation!==operation)return fail('Ya estoy reuniendo otros archivos. Termina o cancela esa colección primero.');
    const ids=[...new Set([...state.artifactIds,...files.map(a=>a.id)])];
    if(ids.length>product.mediaMaxFiles)return fail(`Ya llegaste al máximo de ${product.mediaMaxFiles} archivos. Dime «terminar».`);
    await ctx.legacy.c.query('UPDATE sessions_v2 SET partial_args=$2,version=version+1 WHERE id=$1 AND status=\'active\'',[active.id,JSON.stringify({...state,artifactIds:ids})]);
    return ok(`La colección sigue abierta con ${ids.length} archivos. Dime «terminar» para hacer el PDF.`);
  }
  await openCollectionSessionV2(ctx.legacy.c,ctx.actorId,ctx.chatId,operation,files.map(a=>a.id),ctx.now);
  return ok(`Voy a reunir ${operation==='images_pdf'?'tus fotos en un PDF':'tus PDF'}. Envía los que faltan y dime «terminar». Máximo ${product.mediaMaxFiles} archivos; vence en ${product.sessionMinutes} minutos.`);
}
/** Session shell only; final work goes back through Policy and the historical media queue. */
export async function continueCollectionV2(ctx: ToolCtx, session: SessionV2, modelRequestedFinish=false): Promise<ToolResult|string|undefined> {
  const decision=modelRequestedFinish?{kind:'finish_collection' as const}:decideSessionV2(session,ctx.msg.text,ctx.now,ctx.msg.attachments.length>0);
  if(!['collect','finish_collection'].includes(decision.kind))return;
  if(decision.kind==='collect')await prepareArtifactsV2(ctx);
  return executionTransaction(ctx,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-v2-execution-admission'))");
    const live=(await c.query<{partial_args:unknown}>(`SELECT partial_args FROM sessions_v2 WHERE id=$1 AND actor_id=$2 AND chat_id=$3 AND status='active' AND expires_at>$4 FOR UPDATE`,[session.id,ctx.actor.id,ctx.chat.id,ctx.now])).rows[0];
    if(!live)return 'Esa colección ya venció. Pídeme una nueva.';
    const state=collection.parse(live.partial_args);
    if(decision.kind==='collect'){
      const files=await currentFiles({...ctx,c},state.operation);
      if(!files.length)return state.operation==='images_pdf'?'Ese archivo no es una foto. Envíame una imagen.':'Ese archivo no es un PDF. Envíame un PDF.';
      const ids=[...new Set([...state.artifactIds,...files.map(a=>a.id)])];
      if(ids.length>product.mediaMaxFiles)return `Ya llegaste al máximo de ${product.mediaMaxFiles} archivos. Dime «terminar».`;
      await c.query(`UPDATE sessions_v2 SET partial_args=$2,version=version+1 WHERE id=$1`,[session.id,JSON.stringify({...state,artifactIds:ids})]);
      return `Llevo ${ids.length} ${state.operation==='images_pdf'?(ids.length===1?'foto':'fotos'):'PDF'}. Dime «terminar» cuando estén todos.`;
    }
    if(!state.artifactIds.length)return 'Todavía no tengo archivos para esa colección. Envíalos primero.';
    if(state.operation==='pdf_merge' && state.artifactIds.length<2)return 'Necesito al menos dos PDF para unirlos. Envía otro.';
    const safeRefs=new SafeRefs(state.artifactIds.map(id=>({kind:'artifactRef' as const,id,chatId:ctx.chat.id,label:'Archivo de la colección',access:{visibility:'personal' as const,ownerId:ctx.actor.id}})));
    const result=await executeToolV2({...ctx,c,inboxTransaction:true},'media.process',{operation:state.operation,artifactRefs:safeRefs.list({chatId:ctx.chat.id,actorId:ctx.actor.id}).map(r=>r.ref)},{callOrigin:'session',safeRefMap:safeRefs});
    if(['ok','queued'].includes(result.status))await c.query("UPDATE sessions_v2 SET status='done',version=version+1 WHERE id=$1 AND status='active'",[session.id]);
    return result;
  });
}
