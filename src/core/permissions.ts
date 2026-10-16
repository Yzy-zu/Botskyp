import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import type { Msg } from '../wa/types.js';
import { product } from '../../config/product.js';
export type PermissionKey = 'chat.use'|'games.use'|'xp.use'|'moderation.act'|'notes.manage_shared'|'chat.configure'|'config.global'|'jobs.diagnose'|'school.write'|'school.manage'|'minecraft.read'|'infra.minecraft';
export type Actor = {id:string; role:'owner'|'group_admin'|'member';groupMember?:boolean};
export type Chat = {id:string;isGroup:boolean;enabled:boolean;settings:{modules?:Record<string,boolean>}};
export async function actorFor(c:PoolClient,msg:Msg,config:Config):Promise<Actor>{
  const aliases=await c.query<{user_id:string}>("SELECT user_id FROM user_aliases WHERE alias=$1 AND evidence NOT LIKE 'conflict:%'",[msg.senderId]);
  const id=aliases.rows[0]?.user_id ?? msg.senderId;
  // Unresolved LIDs and conflicted aliases never acquire owner/admin privileges.
  if(!id.endsWith('@lid') && config.OWNER_JIDS.includes(id))return {id,role:'owner'};
  const membership=await c.query<{is_admin:boolean}>(`SELECT is_admin FROM group_memberships WHERE chat_id=$1 AND user_id=$2
    AND active AND last_seen_at>clock_timestamp()-$3::int*interval '1 millisecond'`,[msg.chatId,id,product.membershipMaxAgeMs]);
  return {id,role:msg.isGroup && !id.endsWith('@lid') && membership.rows[0]?.is_admin?'group_admin':'member',groupMember:msg.isGroup && Boolean(membership.rowCount)};
}
export function permitted(actor:Actor,chat:Chat,key:PermissionKey):boolean{
  if(!chat.enabled)return false;
  if((key==='school.write' || key==='school.manage') && !chat.isGroup)return false;
  if(['games.use','xp.use','moderation.act'].includes(key) && !chat.isGroup)return false;
  if(actor.role==='owner')return true;
  if(['games.use','xp.use','moderation.act'].includes(key) && !actor.groupMember)return false;
  if((key==='school.write' || key==='school.manage') && !actor.groupMember)return false;
  if(key==='config.global' || key==='jobs.diagnose' || key==='infra.minecraft')return false;
  if(key==='chat.configure' || key==='notes.manage_shared' || key==='school.manage' || key==='moderation.act')return chat.isGroup && actor.role==='group_admin';
  return true;
}
export function moduleEnabled(chat:Chat,module:string,config:Config):boolean{
  if(module==='core')return true;
  if(['school','xp','games','moderation'].includes(module) && !chat.isGroup)return false;
  return chat.settings.modules?.[module] ?? (!chat.isGroup || chat.id===config.LAB_CHAT_ID);
}
export async function privateEligible(c:PoolClient,actor:Actor):Promise<boolean>{
  if(actor.role==='owner')return true;
  const result=await c.query(`SELECT 1 FROM users WHERE id=$1 AND (private_ok_manual OR EXISTS(
    SELECT 1 FROM group_memberships m JOIN chats ch ON ch.id=m.chat_id WHERE m.user_id=$1 AND m.active AND ch.enabled
    AND m.last_seen_at>clock_timestamp()-$2::int*interval '1 millisecond'))`,[actor.id,product.membershipMaxAgeMs]);
  return Boolean(result.rowCount);
}
