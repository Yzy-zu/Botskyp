import pino from 'pino';
import { product } from '../../config/product.js';
import { msgSchema } from '../wa/types.js';
import { fetchAttachment, capacity, digest } from '../modules/media/storage.js';
import { extension } from '../modules/media/catalog.js';
import { registerArtifactV2, registerIncomingArtifactsV2 } from './artifact-registration-v2.js';
import { moduleEnabled } from './permissions.js';
import type { ToolCtx } from './tools.js';

const log=pino({level:'info'});

/** Only authenticated CURRENT/REPLIED messages. No historical download selected by human text. */
export async function prepareArtifactsV2(ctx:ToolCtx):Promise<void>{
  if(!moduleEnabled(ctx.chat,'media',ctx.config) && !moduleEnabled(ctx.chat,'vision',ctx.config))return;
  const ids=[...(ctx.msg.attachments.length?[ctx.msg.id]:[]),...(ctx.msg.quoted?[ctx.msg.quoted.id]:[])];
  for(const id of new Set(ids)){
    const row=(await ctx.c.query<{payload:unknown;canonical_owner:string}>(`SELECT i.payload,coalesce(ua.user_id,i.payload->>'senderId') canonical_owner FROM inbox i JOIN message_turns t ON t.id=i.turn_id
      LEFT JOIN user_aliases ua ON ua.alias=i.payload->>'senderId' AND ua.evidence NOT LIKE 'conflict:%'
      WHERE t.resolved_chat_id=$1 AND t.source_message_id=$3 AND i.status<>'failed'
        AND (coalesce(ua.user_id,i.payload->>'senderId')=$2 OR $4::boolean)
        AND jsonb_array_length(i.payload->'attachments')>0 ORDER BY i.id DESC LIMIT 1`,
    [ctx.chat.id,ctx.actor.id,id,ctx.chat.isGroup && id===ctx.msg.quoted?.id])).rows[0];
    if(!row)continue;
    const source=msgSchema.parse(row.payload), owner=row.canonical_owner;
    const expires=new Date(source.ts.getTime()+product.mediaOriginalDays*86_400_000);
    if(expires<=ctx.now)continue;
    const seen=new Set<string>();
    for(const [index,item] of source.attachments.entries()){
      if(seen.has(item.ref))continue;
      seen.add(item.ref);
      if(!moduleEnabled(ctx.chat,'media',ctx.config) && item.kind!=='image')continue;
      let retained=(await ctx.c.query<{id:string}>(`SELECT id FROM media_attachments WHERE chat_id=$1 AND owner_id=$2 AND source_message_id=$3
        AND artifact_index=$4 AND is_original AND data IS NOT NULL AND expires_at>clock_timestamp()`,[ctx.chat.id,owner,source.id,index])).rows[0];
      if(!retained){
        let media:Awaited<ReturnType<typeof fetchAttachment>>;
        try{media=await fetchAttachment(ctx.config,source,undefined,index);}
        catch{log.info({artifactRetention:'source_unavailable',index},'Artifact input unavailable');continue;}
        await capacity(ctx.c,media.bytes.length);
        retained=(await ctx.c.query<{id:string}>(`INSERT INTO media_attachments(chat_id,owner_id,source_message_id,artifact_index,is_original,mime,extension,size,sha256,data,expires_at)
          VALUES($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
        [ctx.chat.id,owner,source.id,index,media.mime,extension(media.mime),media.bytes.length,digest(media.bytes),media.bytes,expires])).rows[0];
      }
      if(retained)await registerArtifactV2(ctx.c,ctx.config.ROUTER_MODE,{chatId:ctx.chat.id,actorId:owner,sourceMessageId:source.id,mediaId:retained.id,origin:'user_input',kind:item.kind as 'image'|'audio'|'video'|'document'|'sticker',...(item.fileName?{filename:item.fileName}:{})});
    }
    await registerIncomingArtifactsV2(ctx.c,ctx.config,ctx.chat.id,owner,source.id);
  }
}
