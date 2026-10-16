import type { PoolClient } from 'pg';
import { product } from '../../config/product.js';
import { callWord } from '../core/activation.js';
import { msgSchema,type Msg } from './types.js';
type VisionSource={kind:'image';msg:Msg}|{kind:'none'|'missing'};
/** Breed follow-ups require pixels; do not guess from an earlier joke in text history. */
export function breedQuestion(text:string):boolean{
  const question=text.replace(new RegExp(callWord.source,'giu'),' ').replace(/[¿?¡!.,:;]/gu,' ').trim();
  return /^(?:oye\s+)?(?:qu[eé]\s+raza(?:\s+(?:ser[aá]|es|tiene))?|de\s+qu[eé]\s+raza(?:\s+es)?)(?:\s+(?:(?:este|ese|el)\s+(?:perro|gato|animal)|(?:el|la)\s+de\s+(?:la|esta|esa)\s+(?:foto|imagen)))?$/iu.test(question);
}
/** Resolve only accepted input: current image, explicit quote, then a scoped recent image. */
export async function visionSource(c:PoolClient,msg:Msg):Promise<VisionSource>{
  if(msg.attachments.some(a=>a.kind==='image'))return {kind:'image',msg};
  if(msg.attachments.length)return {kind:'none'};
  if(!msg.quoted){
    if(!breedQuestion(msg.text))return {kind:'none'};
    const rows=await c.query<{payload:unknown}>(`SELECT payload FROM inbox WHERE chat_id=$1 AND payload->>'senderId'=$2
      AND received_at>clock_timestamp()-$3::int*interval '1 minute' AND status<>'failed'
      AND payload->'attachments' @> '[{"kind":"image"}]'::jsonb
      ORDER BY id DESC LIMIT 1`,[msg.chatId,msg.senderId,product.recentImageMinutes]);
    const original=msgSchema.safeParse(rows.rows[0]?.payload);
    if(original.success){
      const image=original.data;
      const age=msg.ts.getTime()-image.ts.getTime();
      if(image.chatId===msg.chatId && image.senderId===msg.senderId && !image.fromMe && age>=0 && age<=product.recentImageMinutes*60_000)return {kind:'image',msg:image};
    }
    return {kind:'missing'};
  }
  const rows=await c.query<{payload:unknown}>(`SELECT payload FROM inbox WHERE chat_id=$1 AND payload->>'id'=$2
    AND received_at>clock_timestamp()-$3::int*interval '1 day' ORDER BY id DESC LIMIT 1`,[msg.chatId,msg.quoted.id,product.contextRetentionDays]);
  const original=msgSchema.safeParse(rows.rows[0]?.payload);
  if(original.success && original.data.chatId===msg.chatId && original.data.attachments.some(a=>a.kind==='image'))return {kind:'image',msg:original.data};
  return {kind:msg.quoted.attachments?.some(a=>a.kind==='image') || breedQuestion(msg.text)?'missing':'none'};
}
