import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { transaction } from '../../db/client.js';
import type { Config } from '../../config.js';
import type { Delivery } from '../../wa/types.js';
import { mediaAllowed } from './access.js';
import { validateBytes,safeName,extension } from './catalog.js';
import { digest } from './storage.js';
import { product } from '../../../config/product.js';
const payload=z.strictObject({text:z.string(),sourceId:z.string(),attachmentId:z.uuid(),actorId:z.string(),jobId:z.string().regex(/^[1-9]\d*$/),mediaKind:z.enum(['image','video','audio','document','sticker']),fileName:z.string()});
export async function mediaDelivery(db:Db,config:Config,row:{id:string;chat_id:string;payload:unknown}):Promise<Delivery['media']|undefined>{
  const p=payload.safeParse(row.payload);if(!p.success)return undefined;
  return transaction(db,async c=>{
    if(!await mediaAllowed(c,config,row.chat_id,p.data.actorId))return undefined;
    const a=(await c.query<{data:Buffer;mime:string;sha256:string}>(`SELECT a.data,a.mime,a.sha256 FROM media_attachments a JOIN jobs j ON j.id=a.job_id
      WHERE a.id=$1 AND a.chat_id=$2 AND a.owner_id=$3 AND a.job_id=$4 AND NOT a.is_original AND a.data IS NOT NULL
      AND a.expires_at>clock_timestamp() AND j.status='done' AND j.owner_id=a.owner_id AND j.chat_id=a.chat_id
      AND EXISTS(SELECT 1 FROM outbox o WHERE o.id=$5 AND o.payload->>'attachmentId'=a.id::text AND o.payload->>'jobId'=j.id::text)`,[p.data.attachmentId,row.chat_id,p.data.actorId,p.data.jobId,row.id])).rows[0];
    if(!a || digest(a.data)!==a.sha256)return undefined;
    try{validateBytes(a.data,a.mime);if(safeName(p.data.fileName.replace(/^botsky-/,'').replace(/\.[^.]+$/,''),extension(a.mime))!==p.data.fileName)return undefined;}
    catch{return undefined;}
    return {kind:p.data.mediaKind,mime:a.mime,base64:a.data.toString('base64'),fileName:p.data.fileName};
  });
}
export async function reportMediaDeliveries(db:Db,routing:Config|Config['ROUTER_MODE']='v1'):Promise<void>{
  const mode=typeof routing==='string'?routing:routing.ROUTER_MODE;
  const canary=typeof routing==='string'?null:routing.ROUTER_V1_1_CHAT_IDS ?? null;
  await db.query(`INSERT INTO outbox(chat_id,payload,dedupe_key)
    SELECT j.chat_id,jsonb_build_object('text',CASE WHEN CASE WHEN $3::text[] IS NULL THEN $2::text='v1_1' ELSE j.chat_id=ANY($3::text[]) END THEN 'No pude confirmar la entrega de todos los archivos. No repetí entregas pendientes de confirmar.' ELSE 'Trabajo #'||j.id||': no pude confirmar la entrega de todos los archivos. Consulta «bot trabajos». No repetí entregas inciertas.' END,'sourceId',j.source_message_id),
      'media:delivery-problem:'||j.id FROM jobs j WHERE j.kind='media' AND j.status='done' AND EXISTS(
        SELECT 1 FROM outbox o WHERE o.kind IN ('media_result','media_text') AND o.payload->>'jobId'=j.id::text AND (o.status='failed' OR (o.status='uncertain' AND o.reconcile_attempts>=$1)))
    ON CONFLICT(dedupe_key) DO NOTHING`,[product.maxReconcileAttempts,mode,canary]);
}
