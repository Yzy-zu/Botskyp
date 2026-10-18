import { product } from '../../config/product.js';
import { msgSchema } from '../wa/types.js';
import { fetchAttachment, capacity, digest } from '../modules/media/storage.js';
import { extension } from '../modules/media/catalog.js';
import { registerIncomingArtifactsV2 } from './artifact-registration-v2.js';
import { moduleEnabled } from './permissions.js';
import type { ToolCtx } from './tools.js';
import { referencesPreviousContentV2 } from './artifact-relevance-v2.js';

/** Capture only an accepted authenticated message, own or explicitly quoted in this group. Quotes never fall back to another file. */
export async function prepareArtifactsV2(ctx:ToolCtx):Promise<void>{
  if(!moduleEnabled(ctx.chat,'media',ctx.config) && !moduleEnabled(ctx.chat,'vision',ctx.config))return;
  if(!ctx.msg.attachments.length && !ctx.msg.quoted && !referencesPreviousContentV2(ctx.msg.text) && !/\b(?:sticker|pdf|ocr|transcribe)\b/iu.test(ctx.msg.text))return;
  const row=(await ctx.c.query<{payload:unknown;canonical_owner:string}>(`SELECT i.payload,coalesce(ua.user_id,i.payload->>'senderId') canonical_owner FROM inbox i JOIN message_turns t ON t.id=i.turn_id
    LEFT JOIN user_aliases ua ON ua.alias=i.payload->>'senderId' AND ua.evidence NOT LIKE 'conflict:%'
    WHERE t.resolved_chat_id=$1 AND (coalesce(ua.user_id,i.payload->>'senderId')=$2 OR ($5::boolean AND t.source_message_id=$3)) AND i.status<>'failed'
    AND jsonb_array_length(i.payload->'attachments')=1
    AND (($3::text IS NOT NULL AND t.source_message_id=$3) OR ($3 IS NULL AND i.received_at>clock_timestamp()-$4::int*interval '1 minute'))
    ORDER BY i.id DESC LIMIT 1`,[ctx.chat.id,ctx.actor.id,ctx.msg.attachments.length?ctx.msg.id:ctx.msg.quoted?.id ?? null,product.recentImageMinutes,ctx.chat.isGroup && Boolean(ctx.msg.quoted) && !ctx.msg.attachments.length])).rows[0];
  if(!row)return;
  const sourceOwner=row.canonical_owner;
  const source=msgSchema.parse(row.payload), item=source.attachments[0]!;
  if(!moduleEnabled(ctx.chat,'media',ctx.config) && item.kind!=='image')return;
  if((await ctx.c.query('SELECT 1 FROM chat_artifacts WHERE chat_id=$1 AND actor_id=$2 AND source_message_id=$3 AND expires_at>clock_timestamp()',[ctx.chat.id,sourceOwner,source.id])).rowCount)return;
  const expires=new Date(source.ts.getTime()+product.mediaOriginalDays*86_400_000);
  if(expires<=ctx.now)return;
  const retained=(await ctx.c.query('SELECT 1 FROM media_attachments WHERE chat_id=$1 AND owner_id=$2 AND source_message_id=$3 AND is_original AND data IS NOT NULL AND expires_at>clock_timestamp()',[ctx.chat.id,sourceOwner,source.id])).rowCount;
  if(!retained){
    const media=await fetchAttachment(ctx.config,source);
    await capacity(ctx.c,media.bytes.length);
    await ctx.c.query(`INSERT INTO media_attachments(chat_id,owner_id,source_message_id,is_original,mime,extension,size,sha256,data,expires_at)
      VALUES($1,$2,$3,true,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[ctx.chat.id,sourceOwner,source.id,media.mime,extension(media.mime),media.bytes.length,digest(media.bytes),media.bytes,expires]);
  }
  await registerIncomingArtifactsV2(ctx.c,ctx.config,ctx.chat.id,sourceOwner,source.id);
}
