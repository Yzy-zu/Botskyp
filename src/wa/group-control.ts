import { z } from 'zod';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import { product } from '../../config/product.js';
const member=z.object({id:z.string().regex(/^\d+@(lid|s\.whatsapp\.net)$/),phoneNumber:z.string().regex(/^\d+@s\.whatsapp\.net$/).optional(),admin:z.enum(['admin','superadmin']).nullish()});
export const rosterSchema=z.object({id:z.string(),subject:z.string().max(200).optional(),participants:z.array(member.refine(p=>!p.phoneNumber || p.id.endsWith('@lid') || p.id===p.phoneNumber))}).superRefine((roster,ctx)=>{
  const ids=roster.participants.map(p=>p.id),canonical=roster.participants.map(p=>p.phoneNumber ?? p.id);
  if(new Set(ids).size!==ids.length || new Set(canonical).size!==canonical.length)ctx.addIssue({code:'custom',message:'Ambiguous roster identities'});
});
export type Roster=z.infer<typeof rosterSchema>;
export interface GroupControl{
  roster(chat:string):Promise<Roster>;
  remove(chat:string,user:string):Promise<'accepted'|'retry'|'rejected'|'unknown'>;
  invite(chat:string):Promise<string>;
}
export function findMember(roster:Roster,user:string){return roster.participants.find(p=>p.id===user || p.phoneNumber===user);}
export function botAdmin(roster:Roster,config:Config):boolean{return config.BOT_JIDS.some(id=>Boolean(findMember(roster,id)?.admin));}
export class EvolutionGroups implements GroupControl{
  constructor(private config:Config,private db?:Pick<Db,'query'>){}
  private async check(chat:string):Promise<void>{
    if(!/^\d+@g\.us$/.test(chat))throw new Error('Invalid group');
    const allowed=this.db?Boolean((await this.db.query('SELECT 1 FROM chats WHERE id=$1 AND enabled AND is_group',[chat])).rowCount):chat===this.config.LAB_CHAT_ID;
    if(!allowed)throw new Error('Group disabled or authorization unavailable');
  }
  private async request(path:string,body?:unknown):Promise<Response>{
    return fetch(new URL(path,this.config.EVOLUTION_URL),{method:body?'POST':'GET',headers:{apikey:this.config.EVOLUTION_APIKEY,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(product.requestTimeoutMs),redirect:'error'});
  }
  async roster(chat:string):Promise<Roster>{
    await this.check(chat);const response=await this.request(`/group/findGroupInfos/${this.config.INSTANCE}?groupJid=${encodeURIComponent(chat)}`);
    if(!response.ok){await response.body?.cancel();throw new Error('Roster unavailable');}
    const result=rosterSchema.parse(await response.json());if(result.id!==chat)throw new Error('Unexpected roster');return result;
  }
  async remove(chat:string,user:string):Promise<'accepted'|'retry'|'rejected'|'unknown'>{
    await this.check(chat);if(!/^\d+@s\.whatsapp\.net$/.test(user))return 'rejected';
    try{
      const r=await this.request(`/group/updateParticipant/${this.config.INSTANCE}`,{groupJid:chat,action:'remove',participants:[user]});
      if(r.status===429){await r.body?.cancel();return 'retry';}
      if(!r.ok){await r.body?.cancel();return r.status>=400 && r.status<500 && r.status!==408?'rejected':'unknown';}
      const data=z.object({updateParticipants:z.array(z.object({status:z.union([z.string(),z.number()]),jid:z.string()}))}).safeParse(await r.json());
      const result=data.success?data.data.updateParticipants.find(p=>p.jid===user):undefined;
      if(!result)return 'unknown';return String(result.status)==='200'?'accepted':String(result.status)==='429'?'retry':'rejected';
    }catch{return 'unknown';}
  }
  async invite(chat:string):Promise<string>{
    await this.check(chat);const r=await this.request(`/group/inviteCode/${this.config.INSTANCE}?groupJid=${encodeURIComponent(chat)}`);
    if(!r.ok){await r.body?.cancel();throw new Error('Invite unavailable');}
    const data=z.object({inviteUrl:z.string().regex(/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{22}$/),inviteCode:z.string().regex(/^[A-Za-z0-9]{22}$/)}).parse(await r.json());
    if(data.inviteUrl!==`https://chat.whatsapp.com/${data.inviteCode}`)throw new Error('Unexpected invite');return data.inviteUrl;
  }
}
