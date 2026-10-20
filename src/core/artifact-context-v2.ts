import { observer } from '../observer/index.js';
import { product } from '../../config/product.js';
import { resolveArtifactForOperation } from './artifact-resolution-v2.js';
import { loadExecutionContext } from './policy-v2/context.js';
import { moduleEnabled, privateEligible } from './permissions.js';
import type { ToolCtx } from './tools.js';
import type { SafeRefs } from './safe-refs.js';
import type { Image } from './llm.js';

import { loadArtifactContextSchema } from './tool-registry-v2.js';
export { loadArtifactContextSchema, loadArtifactContextMetaTool } from './tool-registry-v2.js';
/** Rebuild authenticated scope, validate the delivered opaque ref and recheck live bytes/TTL. */
async function loadArtifactContextImplV2(ctx:ToolCtx,safeRefMap:SafeRefs,args:unknown):Promise<{status:string;image?:Image;artifactRef?:string}>{
  const parsed=loadArtifactContextSchema.safeParse(args);
  if(!parsed.success)return {status:'INVALID_MODEL_ARGUMENTS'};
  const scope=await loadExecutionContext(ctx,{callOrigin:'llm',safeRefMap});
  if(!scope.chat.enabled || !moduleEnabled(scope.chat,'vision',ctx.config) || scope.actorId.endsWith('@lid')
    || (scope.chat.isGroup?scope.role!=='owner' && !scope.actor.groupMember:!await privateEligible(ctx.c,scope.actor)))return {status:'DENIED_SCOPE'};
  if((await ctx.c.query("SELECT 1 FROM system_flags WHERE (key='emergency' OR (key='maintenance' AND $1::boolean)) AND value='true'::jsonb",[scope.role!=='owner'])).rowCount)return {status:'DENIED_SYSTEM'};
  const selected=await resolveArtifactForOperation('vision',{c:ctx.c,...scope,...(scope.legacy.msg.quoted?{quotedMessageId:scope.legacy.msg.quoted.id}:{})},parsed.data.artifactRef);
  if(selected.status!=='ok')return {status:selected.status};
  const a=selected.artifact;
  observer.emit(()=>({eventType:'ARTIFACT_CONTEXT_LOADED',stage:'artifact.selected',payload:{args,artifact:a}}));
  const bytes=(await ctx.c.query<{data:Buffer}>(`SELECT data FROM media_attachments WHERE id=$1 AND chat_id=$3 AND owner_id=$4 AND data IS NOT NULL AND expires_at>clock_timestamp()
    UNION ALL SELECT data FROM school_attachments WHERE id=$2 AND chat_id=$3 AND owner_id=$4 AND data IS NOT NULL AND expires_at>clock_timestamp()`,[a.media_attachment_id,a.school_attachment_id,scope.chatId,a.actor_id])).rows[0]?.data;
  if(!bytes || bytes.length>product.visionMaxBytes)return {status:'SOURCE_UNAVAILABLE'};
  return {status:'ok',artifactRef:parsed.data.artifactRef,image:{mimeType:a.mime,data:bytes.toString('base64')}};
}

export async function loadArtifactContextV2(ctx:ToolCtx,safeRefMap:SafeRefs,args:unknown):ReturnType<typeof loadArtifactContextImplV2>{
  observer.emit(()=>({eventType:'ARTIFACT_CONTEXT_LOADED',stage:'artifact.request',payload:{args,safeRefs:safeRefMap}}));
  try{const result=await loadArtifactContextImplV2(ctx,safeRefMap,args);observer.emit(()=>({eventType:'ARTIFACT_CONTEXT_LOADED',stage:'artifact.result',payload:result}));return result;}
  catch(error){observer.emit({eventType:'ARTIFACT_CONTEXT_LOADED',stage:'artifact.error',payload:{args,error}});throw error;}
}
