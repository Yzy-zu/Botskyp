import { driveDelivery } from '../modules/drive/delivery.js';
import { claimBulk } from '../modules/messaging/worker.js';
import { libraryDelivery } from '../modules/packs/delivery.js';
import { mediaDelivery } from '../modules/media/delivery.js';
import { schoolDelivery } from '../modules/school/delivery.js';
import { product } from '../../config/product.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Delivery, Transport } from './types.js';
import { z } from 'zod';
const payloadSchema = z.object({text:z.string(),sourceId:z.string(),attachmentId:z.uuid().optional()});
type Row = {id:string;chat_id:string;payload:unknown;kind:string;status:string;attempts:number;reconcile_attempts:number;provider_msg_id:string|null;dedupe_key:string};
export async function recoverSending(db:Db):Promise<void> {
  await db.query("UPDATE outbox SET status='uncertain',last_error='interrupted',next_try_at=now() WHERE status='sending'");
}
export async function sendNext(db:Db, transport:Transport, config:Config):Promise<boolean> {
  const emergency=await db.query("SELECT key FROM system_flags WHERE key='emergency' AND value='true'::jsonb");
  if (emergency.rowCount) return false;
  const result = await db.query<Row>(`SELECT o.* FROM outbox o WHERE o.status IN ('queued','uncertain') AND o.next_try_at<=now()
    AND (o.kind<>'bulk_text' OR o.status='uncertain' OR EXISTS(SELECT 1 FROM bulk_targets bt JOIN bulk_ops b ON b.id=bt.op_id WHERE bt.outbox_id=o.id AND b.status='running'))
    AND (o.status<>'uncertain' OR o.reconcile_attempts<$1)
    AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.chat_id=o.chat_id AND earlier.id<o.id AND (earlier.status IN ('queued','sending') OR (earlier.status='uncertain' AND earlier.reconcile_attempts<$1))
      AND NOT(earlier.kind='bulk_text' AND earlier.status='queued' AND NOT EXISTS(SELECT 1 FROM bulk_targets bt JOIN bulk_ops b ON b.id=bt.op_id WHERE bt.outbox_id=earlier.id AND b.status='running')))
    AND NOT EXISTS(SELECT 1 FROM outbox recent WHERE recent.chat_id=o.chat_id AND recent.sending_at>now()-$2::int*interval '1 millisecond')
    ORDER BY o.id LIMIT 1`,[product.maxReconcileAttempts,product.outboxGapMs]);
  const row=result.rows[0];
  if (!row) return false;
  const payload=payloadSchema.parse(row.payload);
  const delivery:Delivery={id:row.id,chatId:row.chat_id,text:payload.text,sourceId:payload.sourceId,...(payload.attachmentId?{attachmentId:payload.attachmentId}:{}),...(['bulk_text','drive_file','drive_link'].includes(row.kind)?{requireReceipt:true}:{})};
  if (row.status==='uncertain') {
    let resolution;
    try { resolution=await transport.reconcile(delivery,row.provider_msg_id ?? undefined); }
    catch { resolution={status:'unknown'} as const; }
    if (resolution.status==='found') {
      await db.query("UPDATE outbox SET status='sent',provider_msg_id=$2,sent_at=now(),last_error=NULL WHERE id=$1",[row.id,resolution.id]);
    } else if (resolution.status==='absent' && row.attempts<product.maxSendAttempts) {
      await db.query("UPDATE outbox SET status='queued',next_try_at=now() WHERE id=$1",[row.id]);
      if(row.kind==='bulk_text')await db.query("UPDATE outbox SET status='failed',last_error='bulk_cancelled' WHERE id=$1 AND EXISTS(SELECT 1 FROM bulk_targets t JOIN bulk_ops b ON b.id=t.op_id WHERE t.outbox_id=$1 AND b.status='cancelled')",[row.id]);
    } else {
      await db.query("UPDATE outbox SET reconcile_attempts=reconcile_attempts+1,next_try_at=now()+$2::int*interval '1 millisecond' WHERE id=$1",[row.id,product.retryBaseMs]);
      if (row.reconcile_attempts+1>=product.maxReconcileAttempts) {
        await db.query("INSERT INTO error_log(where_,msg_id,detail) VALUES('outbox',$1,'Entrega incierta; requiere revisión')",[row.id]);
        // Do not recursively send an alert about an uncertain alert.
        if (!row.dedupe_key.startsWith('alert:')) {
          for (const owner of config.OWNER_JIDS) {
            await db.query(`INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
              [owner,JSON.stringify({text:`No pude confirmar la entrega #${row.id}. Requiere revisión; no la repetí.`,sourceId:''}),`alert:${row.id}:${owner}`]);
          }
        }
      }
    }
    return true;
  }
  if(row.kind==='school_attachment' || row.kind==='school_summary'){
    const school=await schoolDelivery(db,config,row);
    if(!school.allowed){
      await db.query("UPDATE outbox SET status='failed',last_error='school_delivery_not_allowed' WHERE id=$1 AND status='queued'",[row.id]);
      await db.query("INSERT INTO error_log(where_,msg_id,detail) VALUES('school.delivery',$1,'Entrega escolar cancelada por permisos, configuración o retención')",[row.id]);
      return true;
    }
    if(school.media)delivery.media=school.media;
  }
  if(row.kind==='media_result'){
    const media=await mediaDelivery(db,config,row);
    if(!media){await db.query("UPDATE outbox SET status='failed',last_error='media_delivery_not_allowed' WHERE id=$1 AND status='queued'",[row.id]);return true;}
    delivery.media=media;
  }
  if(row.kind==='library_item'){
    const media=await libraryDelivery(db,config,row);
    if(!media){await db.query("UPDATE outbox SET status='failed',last_error='library_delivery_not_allowed' WHERE id=$1 AND status='queued'",[row.id]);return true;}
    delivery.media=media;
  }
  if(row.kind==='drive_file' || row.kind==='drive_link'){
    const drive=await driveDelivery(db,config,row);
    if(!drive.allowed){await db.query("UPDATE outbox SET status='failed',last_error='drive_delivery_not_allowed' WHERE id=$1 AND status='queued'",[row.id]);return true;}
    if(drive.media)delivery.media=drive.media;
    delivery.requireReceipt=true;
  }
  // Persist uncertainty BEFORE crossing the network boundary.
  const claimed=row.kind==='bulk_text'?{rowCount:await claimBulk(db,config,row)?1:0}:await db.query("UPDATE outbox SET status='sending',sending_at=now(),attempts=attempts+1 WHERE id=$1 AND status='queued' RETURNING id",[row.id]);
  if (!claimed.rowCount) return false;
  let sent;
  try { sent=await transport.send(delivery); }
  catch { sent={status:'uncertain',reason:'transport_exception'} as const; }
  if (sent.status==='sent') {
    await db.query("UPDATE outbox SET status='sent',provider_msg_id=$2,sent_at=now(),last_error=NULL WHERE id=$1",[row.id,sent.id]);
  } else {
    const status=row.kind==='bulk_text' && sent.status==='retry'?'failed':sent.status==='retry' ? (row.attempts+1<product.maxSendAttempts ? 'queued':'failed') : sent.status;
    await db.query("UPDATE outbox SET status=$2,last_error=$3,next_try_at=now()+$4::int*interval '1 millisecond' WHERE id=$1",
      [row.id,status,sent.reason,Math.max(product.retryBaseMs*2**row.attempts,sent.retryAfterMs ?? 0)]);
    if(sent.id)await db.query('UPDATE outbox SET provider_msg_id=$2 WHERE id=$1',[row.id,sent.id]);
    if (status==='failed') await db.query("INSERT INTO error_log(where_,msg_id,detail) VALUES('outbox',$1,$2)",[row.id,sent.reason]);
  }
  return true;
}
