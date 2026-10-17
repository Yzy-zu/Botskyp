import type { PoolClient } from 'pg';
import type { Config } from '../../config.js';
import { actorFor,moduleEnabled,permitted,privateEligible,type Chat } from '../../core/permissions.js';
export async function libraryAllowed(c:PoolClient,config:Config,chatId:string,actorId:string,manage=false):Promise<boolean>{
  const r=(await c.query<{is_group:boolean;enabled:boolean;settings:Chat['settings']}>('SELECT * FROM chats WHERE id=$1',[chatId])).rows[0];
  if(!r)return false;
  const chat={id:chatId,isGroup:r.is_group,enabled:r.enabled,settings:r.settings};
  const actor=await actorFor(c,{id:'',chatId,isGroup:r.is_group,senderId:actorId,text:'',ts:new Date(),fromMe:false,mentions:[],attachments:[]},config);
  if(!permitted(actor,chat,manage?'chat.configure':'chat.use') || !moduleEnabled(chat,'library',config))return false;
  if(r.is_group && actor.role!=='owner' && !actor.groupMember)return false;
  if(!r.is_group && !await privateEligible(c,actor))return false;
  const flags=(await c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags')).rows;
  return !flags.some(f=>f.value===true && (f.key==='emergency' || (f.key==='maintenance' && actor.role!=='owner')));
}

export async function privateLibraryDestination(c:PoolClient,config:Config,user:string):Promise<boolean>{
  if(!/^\d+@s\.whatsapp\.net$/.test(user) || !await privateEligible(c,{id:user,role:config.OWNER_JIDS.includes(user)?'owner':'member'}))return false;
  const chat=(await c.query<{enabled:boolean;settings:Chat['settings']}>('SELECT enabled,settings FROM chats WHERE id=$1',[user])).rows[0];
  return !chat || (chat.enabled && moduleEnabled({id:user,isGroup:false,...chat},'library',config));
}
