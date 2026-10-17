import type { PoolClient } from 'pg';
import type { Config } from '../../config.js';
import { actorFor,moduleEnabled,permitted,privateEligible,type Chat } from '../../core/permissions.js';
import { product } from '../../../config/product.js';
export async function mediaAllowed(c:PoolClient,config:Config,chatId:string,actorId:string):Promise<boolean>{
  const row=(await c.query<{is_group:boolean;enabled:boolean;settings:Chat['settings']}>('SELECT * FROM chats WHERE id=$1',[chatId])).rows[0];
  if(!row)return false;
  const chat={id:chatId,isGroup:row.is_group,enabled:row.enabled,settings:row.settings};
  const actor=await actorFor(c,{chatId,isGroup:row.is_group,senderId:actorId,id:'',text:'',ts:new Date(),fromMe:false,mentions:[],attachments:[]},config);
  if(!permitted(actor,chat,'chat.use') || !moduleEnabled(chat,'media',config))return false;
  if(row.is_group && actor.role!=='owner'){
    const member=await c.query('SELECT 1 FROM group_memberships WHERE chat_id=$1 AND user_id=$2 AND active AND last_seen_at>clock_timestamp()-$3::int*interval \'1 millisecond\'',[chatId,actor.id,product.membershipMaxAgeMs]);
    if(!member.rowCount)return false;
  }
  if(!row.is_group && !await privateEligible(c,actor))return false;
  const flags=(await c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags')).rows;
  return !flags.some(f=>f.value===true && (f.key==='emergency' || (f.key==='maintenance' && actor.role!=='owner')));
}
