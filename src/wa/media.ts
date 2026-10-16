import { z } from 'zod';
import type { Config } from '../config.js';
import type { Msg } from './types.js';
import type { Image } from '../core/llm.js';
import { product } from '../../config/product.js';
/** Only fetch the current authenticated message. Never download a model-supplied URL or ID. */
export async function currentImage(config:Config,msg:Msg,http:typeof fetch=fetch):Promise<Image>{
  if(!msg.attachments.some(a=>a.kind==='image' && a.ref===`${msg.id}:image`))throw new Error('No current image');
  const response=await http(new URL(`/chat/getBase64FromMediaMessage/${config.INSTANCE}`,config.EVOLUTION_URL),{
    method:'POST',headers:{apikey:config.EVOLUTION_APIKEY,'content-type':'application/json'},
    body:JSON.stringify({message:{key:{id:msg.id,remoteJid:msg.chatId,fromMe:false,...(msg.isGroup?{participant:msg.senderId}:{})}},convertToMp4:false}),
    signal:AbortSignal.timeout(product.requestTimeoutMs),redirect:'error',
  });
  if(!response.ok){await response.body?.cancel();throw new Error('Image unavailable');}
  if(!response.body)throw new Error('Empty image response');
  const chunks:Uint8Array[]=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>product.visionMaxBytes*2){await response.body.cancel().catch(()=>undefined);throw new Error('Image too large');}chunks.push(chunk);}
  const data=z.object({mimetype:z.enum(['image/jpeg','image/png','image/webp','image/heic','image/heif']),base64:z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)}).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if(Buffer.byteLength(data.base64,'base64')>product.visionMaxBytes)throw new Error('Image too large');
  return {mimeType:data.mimetype,data:data.base64};
}
