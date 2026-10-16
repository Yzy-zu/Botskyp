import { z } from 'zod';
import type { Config } from '../config.js';
import { product } from '../../config/product.js';
import type { Delivery,ReconcileResult,SendResult,Transport } from './types.js';
const key=z.object({id:z.string().min(1),remoteJid:z.string(),fromMe:z.boolean()});
const record=z.object({
  key,message:z.record(z.string(),z.unknown()),contextInfo:z.object({stanzaId:z.string().optional()}).nullish(),
});
const history=z.object({messages:z.object({records:z.array(record)})});
class ProviderError extends Error {
  constructor(readonly status:number){super(`Evolution HTTP ${status}`);}
}
export class Evolution implements Transport {
  private readonly base:URL;
  constructor(private readonly config:Config){this.base=new URL(config.EVOLUTION_URL);}
  private async request(path:string,body?:unknown):Promise<unknown>{
    const response=await fetch(new URL(path,this.base),{
      method:body===undefined?'GET':'POST',headers:{apikey:this.config.EVOLUTION_APIKEY,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(product.requestTimeoutMs),redirect:'error',
    });
    if(!response.ok){await response.body?.cancel();throw new ProviderError(response.status);}
    return response.json();
  }
  async state():Promise<boolean>{
    const data=z.object({instance:z.object({instanceName:z.string(),state:z.string()})}).parse(
      await this.request(`/instance/connectionState/${this.config.INSTANCE}`));
    return data.instance.instanceName===this.config.INSTANCE && data.instance.state==='open';
  }
  async participants():Promise<unknown>{
    return this.request(`/group/findGroupInfos/${this.config.INSTANCE}?groupJid=${encodeURIComponent(this.config.LAB_CHAT_ID)}`);
  }
  async send(delivery:Delivery):Promise<SendResult>{
    if(!/^\d+@(g\.us|s\.whatsapp\.net)$/.test(delivery.chatId))return {status:'failed',reason:'unresolved_destination'};
    if(delivery.chatId.endsWith('@g.us') && delivery.chatId!==this.config.LAB_CHAT_ID)return {status:'failed',reason:'outside_lab'};
    try{
      const quote=delivery.sourceId?{quoted:{key:{id:delivery.sourceId,remoteJid:delivery.chatId}}}:{};
      const media=delivery.media;
      const path=media?.kind==='sticker'?'sendSticker':media?'sendMedia':'sendText';
      const body=media?.kind==='sticker'?{number:delivery.chatId,sticker:media.base64,...quote}:media?
        {number:delivery.chatId,mediatype:media.kind,mimetype:media.mime,media:media.base64,caption:delivery.text,
          fileName:media.fileName ?? `adjunto-${delivery.id}.${media.mime==='application/pdf'?'pdf':media.mime.split('/')[1]}`,...quote}:
        {number:delivery.chatId,text:delivery.text,linkPreview:false,...quote};
      const response=z.object({key}).parse(await this.request(`/message/${path}/${this.config.INSTANCE}`,body));
      if(!response.key.fromMe || response.key.remoteJid!==delivery.chatId)return {status:'uncertain',reason:'unexpected_send_response'};
      return {status:'sent',id:response.key.id};
    }catch(error){
      if(error instanceof ProviderError){
        if(error.status===429)return {status:'retry',reason:'provider_rate_limit'};
        if(error.status>=400 && error.status<500 && error.status!==408)return {status:'failed',reason:`provider_${error.status}`};
      }
      return {status:'uncertain',reason:'ambiguous_send'};
    }
  }
  async reconcile(delivery:Delivery,providerId?:string):Promise<ReconcileResult>{
    try{
      const result=history.parse(await this.request(`/chat/findMessages/${this.config.INSTANCE}`,{
        where:{key:{remoteJid:delivery.chatId}},limit:product.historyPageSize,page:1,
      }));
      const matches=result.messages.records.filter(r=>{
        if(!r.key.fromMe || r.key.remoteJid!==delivery.chatId)return false;
        if(providerId)return r.key.id===providerId;
        // Media without a known provider ID stays uncertain; text matching cannot prove file identity.
        if(delivery.media || delivery.attachmentId)return false;
        // A quote links a particular response to its exact inbound request.
        const extended=z.object({text:z.string().optional(),contextInfo:z.object({stanzaId:z.string().optional()}).optional()}).safeParse(r.message['extendedTextMessage']);
        const text=r.message['conversation'] ?? (extended.success?extended.data.text:undefined);
        const quote=r.contextInfo?.stanzaId ?? (extended.success?extended.data.contextInfo?.stanzaId:undefined);
        return Boolean(delivery.sourceId) && quote===delivery.sourceId && text===delivery.text;
      });
      if(matches.length===1 && matches[0])return {status:'found',id:matches[0].key.id};
    }catch{ return {status:'unknown'}; }
    // A missing record cannot prove absence: storage may be delayed or incomplete.
    return {status:'unknown'};
  }
}
