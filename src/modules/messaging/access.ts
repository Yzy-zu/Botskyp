import type { PoolClient } from 'pg';
import type { Config } from '../../config.js';
import { product } from '../../../config/product.js';
import { actorFor,moduleEnabled,permitted,privateEligible,type Chat } from '../../core/permissions.js';
export async function messagingAllowed(c:PoolClient,config:Config,chatId:string,actorId:string,module='messaging'):Promise<boolean>{
  const chat=(await c.query<Chat>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[chatId])).rows[0];
  if(!chat)return false;
  const actor=await actorFor(c,{id:'',chatId,senderId:actorId,isGroup:chat.isGroup,ts:new Date(),text:'',fromMe:false,mentions:[],attachments:[]},config);
  if(!permitted(actor,chat,module==='drive'?'drive.use':'bulk.broadcast') || !moduleEnabled(chat,module,config))return false;
  if(chat.isGroup && actor.role!=='owner' && !actor.groupMember)return false;
  if(!chat.isGroup && !await privateEligible(c,actor))return false;
  return !(await c.query("SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb")).rowCount;
}
export async function destinationAllowed(c:PoolClient,config:Config,target:string):Promise<boolean>{
  if(config.BOT_JIDS.includes(target))return false;
  if(target.endsWith('@g.us')){
    const chat=(await c.query<Chat>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[target])).rows[0];
    return Boolean(chat?.enabled && chat.isGroup && moduleEnabled(chat,'messaging',config));
  }
  if(!/^\d+@s\.whatsapp\.net$/.test(target) || !await privateEligible(c,{id:target,role:config.OWNER_JIDS.includes(target)?'owner':'member'}))return false;
  const chat=(await c.query<Chat>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[target])).rows[0];
  return !chat || (chat.enabled && moduleEnabled(chat,'messaging',config));
}
export type Destination={id:string;target_id:string;label:string;is_group:boolean};
export function safeLabel(value:string):string{return value.normalize('NFC').replace(/[\p{C}@<>]/gu,'').slice(0,80);}
export async function discoverDestinations(c:PoolClient,config:Config):Promise<Destination[]>{
  const groups=(await c.query<{id:string;title:string}>("SELECT id,CASE WHEN id=$1 THEN 'Botsky Lab' ELSE settings->>'group_title' END title FROM chats WHERE enabled AND is_group AND (id=$1 OR settings->>'group_title' IS NOT NULL) ORDER BY id",[config.LAB_CHAT_ID])).rows;
  for(const group of groups){const label=safeLabel(group.title);if(label)await c.query('INSERT INTO messaging_destinations(target_id,is_group,label) VALUES($1,true,$2) ON CONFLICT(target_id) DO UPDATE SET label=excluded.label',[group.id,label]);}
  const users=(await c.query<{id:string;display_name:string|null}>(`SELECT u.id,u.display_name FROM users u WHERE u.id ~ '^[0-9]+@s[.]whatsapp[.]net$' AND (u.private_ok_manual OR u.id=ANY($1::text[]) OR EXISTS(
    SELECT 1 FROM group_memberships m JOIN chats ch ON ch.id=m.chat_id WHERE m.user_id=u.id AND m.active AND ch.enabled AND m.last_seen_at>clock_timestamp()-$2::int*interval '1 millisecond')) ORDER BY u.id LIMIT $3`,[config.OWNER_JIDS,product.membershipMaxAgeMs,product.bulkDailyTargets])).rows;
  for(const u of users)await c.query('INSERT INTO messaging_destinations(target_id,is_group,label) VALUES($1,false,$2) ON CONFLICT DO NOTHING',[u.id,safeLabel(u.display_name ?? '') || 'Contacto autorizado']);
  const rows=(await c.query<Destination>('SELECT * FROM messaging_destinations ORDER BY id')).rows;
  const allowed:Destination[]=[];for(const row of rows)if(await destinationAllowed(c,config,row.target_id))allowed.push(row);
  return allowed;
}
