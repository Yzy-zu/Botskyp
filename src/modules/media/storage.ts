import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Msg } from '../../wa/types.js';
import { product } from '../../../config/product.js';
import { extension,validateBytes } from './catalog.js';
export const digest=(bytes:Buffer):string=>createHash('sha256').update(bytes).digest('hex');
export async function capacity(c:PoolClient,bytes:number):Promise<void>{
  await c.query("SELECT pg_advisory_xact_lock(hashtext('media-storage'))");
  const current=(await c.query<{n:string}>('SELECT coalesce(sum(octet_length(data)),0) n FROM media_attachments WHERE data IS NOT NULL')).rows[0]!;
  if(Number(current.n)+bytes>product.mediaStorageBytes)throw new Error('storage_limit');
}
export async function fetchAttachment(config:Config,msg:Msg,signal?:AbortSignal):Promise<{bytes:Buffer;mime:string}>{
  const item=msg.attachments[0];
  if(msg.fromMe || msg.attachments.length!==1 || !item || !['image','video','audio','document','sticker'].includes(item.kind) || item.ref!==`${msg.id}:${item.kind}`)throw new Error('invalid_attachment');
  const response=await fetch(new URL(`/chat/getBase64FromMediaMessage/${config.INSTANCE}`,config.EVOLUTION_URL),{
    method:'POST',headers:{apikey:config.EVOLUTION_APIKEY,'content-type':'application/json'},
    body:JSON.stringify({message:{key:{id:msg.id,remoteJid:msg.chatId,fromMe:false,...(msg.isGroup?{participant:msg.senderId}:{})}},convertToMp4:false}),
    signal:AbortSignal.any([AbortSignal.timeout(product.mediaDownloadTimeoutMs),...(signal?[signal]:[])]),redirect:'error',
  });
  if(!response.ok || !response.body){await response.body?.cancel();throw new Error('attachment_unavailable');}
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>product.mediaInputBytes*1.5){await reader.cancel();throw new Error('size_limit');}chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const data=z.object({mimetype:z.string(),base64:z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const mime=data.mimetype.toLowerCase().split(';')[0]!;const bytes=Buffer.from(data.base64,'base64');validateBytes(bytes,mime);
  if(item.mime && item.mime.split(';')[0]!==mime)throw new Error('mime_mismatch');
  if(item.kind==='image' && !mime.startsWith('image/'))throw new Error('mime_mismatch');
  if(item.kind==='video' && !(mime.startsWith('video/') || mime==='application/ogg'))throw new Error('mime_mismatch');
  if(item.kind==='audio' && !(mime.startsWith('audio/') || mime==='application/ogg'))throw new Error('mime_mismatch');
  extension(mime);return {bytes,mime};
}
