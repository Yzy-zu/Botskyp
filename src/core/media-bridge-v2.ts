import { enqueueMedia } from '../modules/media/service.js';
import { requestSchema } from '../modules/media/catalog.js';
import { ok, fail, type ToolResult } from './tools.js';
import { SafeRefs } from './safe-refs.js';
import { resendArtifactV2 } from './artifact-resend-v2.js';
import type { ExecutionContextV2, PolicyDecision } from './policy-v2/types.js';

/** Called solely after Policy has resolved a live scoped artifact. No raw model IDs or paths. */
export async function runMediaBridgeV2(ctx:ExecutionContextV2,decision:PolicyDecision):Promise<ToolResult>{
  const a=decision.resolvedSafeRefs.find(r=>r.kind==='artifactRef');
  if(decision.resolvedArgs.operation==='resend'){
    if(!a)return fail('No tengo ese archivo disponible en este chat.');
    // The executor already owns this transaction, including artifact delivery provenance.
    const selected=new SafeRefs([{kind:'artifactRef',id:a.id,chatId:ctx.chatId,label:'Archivo seleccionado',access:{visibility:'personal',ownerId:ctx.actorId}}]);
    const ref=selected.list({chatId:ctx.chatId,actorId:ctx.actorId})[0]!.ref;
    const resent=await resendArtifactV2({...ctx.legacy,inboxTransaction:true},selected,ref);
    return resent.status==='queued'?ok('',{deliveryRequested:true}):fail('No pude recuperar ese archivo para enviarlo. Reenvíame el original.');
  }
  const args=requestSchema.parse(decision.resolvedArgs);
  const sources:unknown[]=[];
  for(const a of [...new Map(decision.resolvedSafeRefs.filter(r=>r.kind==='artifactRef').map(r=>[r.id,r])).values()]){
    const row=(await ctx.legacy.c.query<{media_attachment_id:string|null;school_attachment_id:string|null}>(
      'SELECT media_attachment_id,school_attachment_id FROM chat_artifacts WHERE id=$1 AND chat_id=$2 AND actor_id=$3 AND expires_at>clock_timestamp()', [a.id,ctx.chatId,ctx.actorId])).rows[0];
    if(!row)return fail('Ese archivo ya no está disponible. Reenvíalo.');
    sources.push(row.media_attachment_id?{storedId:row.media_attachment_id}:{schoolStoredId:row.school_attachment_id});
  }
  return enqueueMedia(ctx.legacy,args,sources);
}
