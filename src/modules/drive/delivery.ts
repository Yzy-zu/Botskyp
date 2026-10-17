import { z } from 'zod';
import { product } from '../../../config/product.js';
import type { Config } from '../../config.js';
import { transaction,type Db } from '../../db/client.js';
import type { Delivery } from '../../wa/types.js';
import { privateEligible } from '../../core/permissions.js';
import { driveAllowed } from './service.js';
import { digest } from '../media/storage.js';
import { validateBytes,safeName,extension } from '../media/catalog.js';
const payload=z.strictObject({text:z.string(),sourceId:z.string(),jobId:z.string().regex(/^[1-9]\d*$/),actorId:z.string(),originChatId:z.string(),attachmentId:z.uuid().optional()});
export async function driveDelivery(db:Db,config:Config,row:{id:string;kind:string;chat_id:string;payload:unknown}):Promise<{allowed:boolean;media?:Delivery['media']}>{
  const data=payload.safeParse(row.payload);if(!data.success)return {allowed:false};const p=data.data;
  return transaction(db,async c=>{
    if(!await driveAllowed(c,config,p.originChatId,p.actorId))return {allowed:false};
    const job=(await c.query<{result:{deliveryText:string;target:string;verifiedAt:string}}>(`SELECT j.result FROM jobs j JOIN drive_operations d ON d.job_id=j.id WHERE j.id=$1 AND j.kind='drive' AND j.status='done' AND j.owner_id=$2 AND j.chat_id=$3 AND j.outbox_id=$4 AND d.phase='done'`,[p.jobId,p.actorId,p.originChatId,row.id])).rows[0];
    if(!job || job.result.deliveryText!==p.text || job.result.target!==row.chat_id)return {allowed:false};
    if(row.kind==='drive_link'){
      const verified=Date.parse(job.result.verifiedAt);
      if(!Number.isFinite(verified) || Date.now()-verified>product.driveLinkLeaseMs)return {allowed:false};
      const chat=(await c.query<{enabled:boolean}>('SELECT enabled FROM chats WHERE id=$1',[p.actorId])).rows[0];
      return {allowed:row.chat_id===p.actorId && chat?.enabled!==false && await privateEligible(c,{id:p.actorId,role:config.OWNER_JIDS.includes(p.actorId)?'owner':'member'})};
    }
    if(row.chat_id!==p.originChatId || !p.attachmentId)return {allowed:false};
    const a=(await c.query<{data:Buffer;sha256:string;mime:string;size:string}>('SELECT data,sha256,mime,size FROM media_attachments WHERE id=$1 AND job_id=$2 AND chat_id=$3 AND owner_id=$4 AND expires_at>clock_timestamp() AND data IS NOT NULL',[p.attachmentId,p.jobId,row.chat_id,p.actorId])).rows[0];
    if(!a || a.data.length!==Number(a.size) || digest(a.data)!==a.sha256)return {allowed:false};
    try{validateBytes(a.data,a.mime);}catch{return {allowed:false};}
    return {allowed:true,media:{kind:'document',mime:a.mime,base64:a.data.toString('base64'),fileName:safeName(`drive-${p.jobId}`,extension(a.mime))}};
  });
}
