import { z } from 'zod';
import type { Msg } from './types.js';
const identity=z.string().regex(/^\d+@(s\.whatsapp\.net|lid)$/);
const jid=z.string().regex(/^\d+@(s\.whatsapp\.net|lid|g\.us)$/);
const textMessage=z.object({text:z.string().optional()});
const quotedMessage=z.object({conversation:z.string().optional(),extendedTextMessage:textMessage.optional(),imageMessage:z.object({mimetype:z.string().optional(),caption:z.string().optional()}).optional()});
const contextSchema=z.object({
  stanzaId:z.string().optional(),participant:identity.optional(),mentionedJid:z.array(identity).default([]),quotedMessage:quotedMessage.optional(),
});
const keySchema=z.object({
  id:z.string().min(1),remoteJid:jid,fromMe:z.boolean(),participant:z.string().optional(),
});
const dataSchema=z.object({
  key:keySchema,message:z.record(z.string(),z.unknown()),
  messageTimestamp:z.union([z.number(),z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().positive().max(8_640_000_000_000)),
  contextInfo:contextSchema.nullish(),
});
const mediaSchema=z.object({fileName:z.string().optional(),caption:z.string().optional(),mimetype:z.string().optional(),contextInfo:contextSchema.optional()});
const extendedSchema=textMessage.extend({contextInfo:contextSchema.optional()});
export type Reaction={kind:'reaction';msgId:string;chatId:string;actorId:string;emoji:string};
export type NormalizedEvent={kind:'message';message:Msg}|Reaction;

/** Both webhook data and REST history records carry the provider's original key. */
export function normalizeData(input:unknown):NormalizedEvent|null {
  const data=dataSchema.parse(input);
  if(data.key.fromMe)return null;
  const isGroup=data.key.remoteJid.endsWith('@g.us');
  const senderId=identity.parse(isGroup?data.key.participant:data.key.remoteJid);
  const reaction=data.message['reactionMessage'];
  if(reaction){
    const r=z.object({key:z.object({id:z.string().min(1)}),text:z.string()}).parse(reaction);
    return {kind:'reaction',msgId:r.key.id,chatId:data.key.remoteJid,actorId:senderId,emoji:r.text};
  }
  let text='';
  let context=data.contextInfo;
  const attachments:Msg['attachments']=[];
  if(typeof data.message['conversation']==='string')text=data.message['conversation'];
  else if(data.message['extendedTextMessage']){
    const extended=extendedSchema.parse(data.message['extendedTextMessage']);text=extended.text ?? '';context ??= extended.contextInfo;
  }
  for(const [providerKind,kind] of [['audioMessage','audio'],['imageMessage','image'],['documentMessage','document'],['videoMessage','video'],['stickerMessage','sticker']] as const){
    if(!data.message[providerKind])continue;
    const media=mediaSchema.parse(data.message[providerKind]);
    text=media.caption ?? text;context ??= media.contextInfo;
    attachments.push({kind,ref:`${data.key.id}:${kind}`,...(media.mimetype?{mime:media.mimetype}:{}),...(media.fileName?{fileName:media.fileName}:{})});
  }
  if(!text && !attachments.length)return null;
  const quoted=context?.stanzaId?{
    id:context.stanzaId,fromBot:false,
    ...(context.participant?{senderId:context.participant}:{}),
    ...(context.quotedMessage?.imageMessage?{attachments:[{kind:'image' as const,ref:`${context.stanzaId}:image`,...(context.quotedMessage.imageMessage.mimetype?{mime:context.quotedMessage.imageMessage.mimetype}:{})}]}:{}),
    ...(context.quotedMessage?{text:context.quotedMessage.conversation ?? context.quotedMessage.extendedTextMessage?.text ?? ''}:{}),
  }:undefined;
  const rawQa = typeof (input as { qaMode?: unknown })?.qaMode === 'string' ? (input as { qaMode?: unknown }).qaMode : undefined;
  const qaMode = rawQa === 'SAFE' || rawQa === 'LIVE_SAFE' ? rawQa : undefined;
  return {kind:'message',message:{
    id:data.key.id,chatId:data.key.remoteJid,isGroup,senderId,ts:new Date(data.messageTimestamp*1000),text,
    fromMe:false,mentions:context?.mentionedJid ?? [],attachments,...(quoted?{quoted}:{}),...(qaMode?{qaMode}:{}),
  }};
}
export function normalizeEvent(input:unknown,instance:string):NormalizedEvent|null {
  const event=z.object({event:z.string(),instance:z.string(),data:z.unknown(),qaMode:z.enum(['SAFE','LIVE_SAFE']).optional()}).passthrough().parse(input);
  if(event.instance!==instance || event.event!=='messages.upsert')return null;
  const res = normalizeData(event.data);
  if (res?.kind === 'message' && event.qaMode) {
    res.message.qaMode = event.qaMode;
  }
  return res;
}
export function normalizeMessage(input:unknown,instance:string):Msg|null {
  const event=normalizeEvent(input,instance);
  return event?.kind==='message'?event.message:null;
}
