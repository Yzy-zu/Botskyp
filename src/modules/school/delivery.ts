import { z } from 'zod';
import type { Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { schoolDestination } from './automation.js';
import { storedMediaSchema,type StoredMedia } from './attachments.js';
const attachmentPayload=z.strictObject({text:z.string(),sourceId:z.string(),attachmentId:z.uuid(),actorId:z.string()});
const summaryPayload=z.strictObject({text:z.string(),sourceId:z.string(),automationId:z.string().regex(/^[1-9]\d*$/)});
export async function schoolDelivery(db:Db,config:Config,row:{id:string;chat_id:string;kind:string;payload:unknown}):Promise<{allowed:boolean;media?:StoredMedia}>{
  const flags=(await db.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags')).rows;
  if(flags.some(f=>f.key==='emergency' && f.value===true))return {allowed:false};
  const maintenance=flags.some(f=>f.key==='maintenance' && f.value===true);
  if(row.kind==='school_summary'){
    const parsed=summaryPayload.safeParse(row.payload);if(!parsed.success)return {allowed:false};
    const a=(await db.query<{owner_id:string;chat_id:string}>(`SELECT a.owner_id,a.chat_id FROM automations a JOIN school_config s ON s.chat_id=a.chat_id
      WHERE a.id=$1 AND a.outbox_id=$2 AND a.enabled AND s.target_group_id=$3`,[parsed.data.automationId,row.id,row.chat_id])).rows[0];
    if(!a || (maintenance && !config.OWNER_JIDS.includes(a.owner_id)))return {allowed:false};
    return {allowed:await schoolDestination(db,config,a.chat_id,a.owner_id) && await schoolDestination(db,config,row.chat_id,a.owner_id)};
  }
  const parsed=attachmentPayload.safeParse(row.payload);if(!parsed.success)return {allowed:false};
  if(maintenance && !config.OWNER_JIDS.includes(parsed.data.actorId))return {allowed:false};
  if(!await schoolDestination(db,config,row.chat_id,parsed.data.actorId,false))return {allowed:false};
  const attachment=(await db.query<{kind:string;mime:string;data:Buffer}>(`SELECT a.kind,a.mime,a.data FROM school_attachments a
    WHERE a.id=$1 AND a.chat_id=$2 AND a.data IS NOT NULL AND a.expires_at>clock_timestamp() AND EXISTS(
      SELECT 1 FROM school_tasks t WHERE t.chat_id=a.chat_id AND a.id=ANY(t.attachment_ids) AND t.deleted_at IS NULL)`,[parsed.data.attachmentId,row.chat_id])).rows[0];
  if(!attachment)return {allowed:false};
  const media=storedMediaSchema.safeParse({kind:attachment.kind,mime:attachment.mime,base64:attachment.data.toString('base64')});
  return media.success?{allowed:true,media:media.data}:{allowed:false};
}
