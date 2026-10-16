import { product } from '../../config/product.js';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Delivery, Transport } from './types.js';
import { z } from 'zod';
const payloadSchema = z.object({text:z.string(),sourceId:z.string()});
type Row = {id:string;chat_id:string;payload:unknown;status:string;attempts:number;reconcile_attempts:number;provider_msg_id:string|null;dedupe_key:string};
export async function recoverSending(db:Db):Promise<void> {
  await db.query("UPDATE outbox SET status='uncertain',last_error='interrupted',next_try_at=now() WHERE status='sending'");
}
export async function sendNext(db:Db, transport:Transport, config:Config):Promise<boolean> {
  const emergency=await db.query("SELECT key FROM system_flags WHERE key='emergency' AND value='true'::jsonb");
  if (emergency.rowCount) return false;
  const result = await db.query<Row>(`SELECT o.* FROM outbox o WHERE o.status IN ('queued','uncertain') AND o.next_try_at<=now()
    AND (o.status<>'uncertain' OR o.reconcile_attempts<$1)
    AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.chat_id=o.chat_id AND earlier.id<o.id AND (earlier.status IN ('queued','sending') OR (earlier.status='uncertain' AND earlier.reconcile_attempts<$1)))
    AND NOT EXISTS(SELECT 1 FROM outbox recent WHERE recent.chat_id=o.chat_id AND recent.sending_at>now()-$2::int*interval '1 millisecond')
    ORDER BY o.id LIMIT 1`,[product.maxReconcileAttempts,product.outboxGapMs]);
  const row=result.rows[0];
  if (!row) return false;
  const payload=payloadSchema.parse(row.payload);
  const delivery:Delivery={id:row.id,chatId:row.chat_id,...payload};
  if (row.status==='uncertain') {
    let resolution;
    try { resolution=await transport.reconcile(delivery,row.provider_msg_id ?? undefined); }
    catch { resolution={status:'unknown'} as const; }
    if (resolution.status==='found') {
      await db.query("UPDATE outbox SET status='sent',provider_msg_id=$2,sent_at=now(),last_error=NULL WHERE id=$1",[row.id,resolution.id]);
    } else if (resolution.status==='absent' && row.attempts<product.maxSendAttempts) {
      await db.query("UPDATE outbox SET status='queued',next_try_at=now() WHERE id=$1",[row.id]);
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
  // Persist uncertainty BEFORE crossing the network boundary.
  const claimed=await db.query("UPDATE outbox SET status='sending',sending_at=now(),attempts=attempts+1 WHERE id=$1 AND status='queued' RETURNING id",[row.id]);
  if (!claimed.rowCount) return false;
  let sent;
  try { sent=await transport.send(delivery); }
  catch { sent={status:'uncertain',reason:'transport_exception'} as const; }
  if (sent.status==='sent') {
    await db.query("UPDATE outbox SET status='sent',provider_msg_id=$2,sent_at=now(),last_error=NULL WHERE id=$1",[row.id,sent.id]);
  } else {
    const status=sent.status==='retry' ? (row.attempts+1<product.maxSendAttempts ? 'queued':'failed') : sent.status;
    await db.query("UPDATE outbox SET status=$2,last_error=$3,next_try_at=now()+$4::int*interval '1 millisecond' WHERE id=$1",
      [row.id,status,sent.reason,product.retryBaseMs*2**row.attempts]);
    if (status==='failed') await db.query("INSERT INTO error_log(where_,msg_id,detail) VALUES('outbox',$1,$2)",[row.id,sent.reason]);
  }
  return true;
}
