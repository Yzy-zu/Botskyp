import { z } from 'zod';
import { product } from '../../../config/product.js';
import type { ToolCtx } from '../../core/tools.js';
import { msgSchema,type Msg } from '../../wa/types.js';
export const storedMediaSchema=z.strictObject({kind:z.enum(['image','document']),mime:z.enum(['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']),base64:z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/)});
const mimeSchema=storedMediaSchema.shape.mime;
export type StoredMedia=z.infer<typeof storedMediaSchema>;
/** Resolve actual input only. An explicit unknown quote never falls back to another user's file. */
export async function attachmentSource(ctx:ToolCtx):Promise<Msg|undefined>{
  if(ctx.msg.attachments.length)return ctx.msg;
  if(ctx.msg.quoted){
    const row=await ctx.c.query<{payload:unknown}>(`SELECT payload FROM inbox WHERE chat_id=$1 AND payload->>'id'=$2 AND status<>'failed'
      AND received_at>clock_timestamp()-$3::int*interval '1 day' ORDER BY id DESC LIMIT 1`,[ctx.chat.id,ctx.msg.quoted.id,product.schoolOriginalDays]);
    const original=msgSchema.safeParse(row.rows[0]?.payload);
    return original.success && original.data.chatId===ctx.chat.id && !original.data.fromMe?original.data:undefined;
  }
  const row=await ctx.c.query<{payload:unknown}>(`SELECT payload FROM inbox WHERE chat_id=$1 AND payload->>'senderId'=$2 AND status<>'failed'
    AND received_at>clock_timestamp()-$3::int*interval '1 minute' AND jsonb_array_length(payload->'attachments')>0 ORDER BY id DESC LIMIT 1`,[ctx.chat.id,ctx.msg.senderId,product.recentImageMinutes]);
  const original=msgSchema.safeParse(row.rows[0]?.payload);
  if(!original.success)return undefined;
  const age=ctx.now.getTime()-original.data.ts.getTime();
  return age>=0 && age<=product.recentImageMinutes*60_000 && original.data.senderId===ctx.msg.senderId && original.data.chatId===ctx.chat.id && !original.data.fromMe?original.data:undefined;
}
/** Download solely by the authenticated message key; no URLs, paths or IDs from Gemini. */
export async function captureAttachment(ctx:ToolCtx,source:Msg):Promise<{id:string;media:StoredMedia}>{
  if(source.chatId!==ctx.chat.id || source.fromMe || source.attachments.length!==product.schoolAttachmentLimit)throw new Error('Invalid attachment scope or count');
  const item=source.attachments[0]!;
  if(!['image','document'].includes(item.kind) || item.ref!==`${source.id}:${item.kind}`)throw new Error('Unsupported school attachment');
  const response=await fetch(new URL(`/chat/getBase64FromMediaMessage/${ctx.config.INSTANCE}`,ctx.config.EVOLUTION_URL),{
    method:'POST',headers:{apikey:ctx.config.EVOLUTION_APIKEY,'content-type':'application/json'},
    body:JSON.stringify({message:{key:{id:source.id,remoteJid:source.chatId,fromMe:false,...(source.isGroup?{participant:source.senderId}:{})}},convertToMp4:false}),
    signal:AbortSignal.timeout(product.requestTimeoutMs),redirect:'error',
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Attachment unavailable');}
  if(!response.body)throw new Error('Empty attachment');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>product.schoolAttachmentBytes*2)throw new Error('Attachment too large');chunks.push(chunk);}
  const data=z.object({mimetype:mimeSchema,base64:storedMediaSchema.shape.base64}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const media=storedMediaSchema.parse({kind:item.kind,mime:data.mimetype,base64:data.base64});
  if((media.kind==='image')!==media.mime.startsWith('image/'))throw new Error('MIME mismatch');
  const bytes=Buffer.from(media.base64,'base64');
  if(!bytes.length || bytes.length>product.schoolAttachmentBytes)throw new Error('Attachment too large');
  // Resolve a quoted author's canonical identity using verified evidence, never model data.
  const alias=await ctx.c.query<{user_id:string}>("SELECT user_id FROM user_aliases WHERE alias=$1 AND evidence NOT LIKE 'conflict:%'",[source.senderId]);
  const owner=alias.rows[0]?.user_id ?? source.senderId;
  const row=await ctx.c.query<{id:string}>(`INSERT INTO school_attachments(chat_id,owner_id,source_message_id,kind,mime,data,size,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(chat_id,owner_id,source_message_id,kind) DO UPDATE SET source_message_id=excluded.source_message_id RETURNING id`,
  [ctx.chat.id,owner,source.id,media.kind,media.mime,bytes,bytes.length,new Date(source.ts.getTime()+product.schoolOriginalDays*86_400_000)]);
  return {id:row.rows[0]!.id,media};
}
