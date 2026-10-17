import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import { fail,ok,type ToolCtx,type ToolResult } from '../../core/tools.js';
import { bulkAudit } from './service.js';
import { messagingAllowed } from './access.js';
import type { BulkOperation } from './schemas.js';
export async function stopPending(c:PoolClient,id:string,reason:string):Promise<void>{
  await c.query(`UPDATE outbox SET status='failed',last_error=$2 WHERE status='queued' AND id IN (SELECT outbox_id FROM bulk_targets WHERE op_id=$1)`,[id,reason]);
  await c.query(`UPDATE bulk_targets SET status='skipped',detail=$2,done_at=clock_timestamp() WHERE op_id=$1 AND status='pending' AND (outbox_id IS NULL OR EXISTS(SELECT 1 FROM outbox o WHERE o.id=outbox_id AND o.status='failed' AND o.last_error=$2))`,[id,reason]);
}
export async function manageOperation(ctx:ToolCtx,id:string,action:'cancel'|'retry'|'resume'):Promise<ToolResult>{
  const op=(await ctx.c.query<BulkOperation>('SELECT * FROM bulk_ops WHERE id=$1 AND chat_id=$2 AND actor_id=$3 FOR UPDATE',[id,ctx.chat.id,ctx.actor.id])).rows[0];
  if(!op || !await messagingAllowed(ctx.c,ctx.config,op.chat_id,op.actor_id))return fail('No.');
  if(action==='cancel'){
    if(!['draft','queued','running','paused'].includes(op.status))return ok(`Operación ${id}: ${op.status}.`);
    await stopPending(ctx.c,id,'bulk_cancelled');
    await ctx.c.query("UPDATE bulk_ops SET status='cancelled',finished_at=clock_timestamp(),reason='cancelled' WHERE id=$1",[id]);
    if(op.job_id)await ctx.c.query("UPDATE jobs SET status='failed',error='cancelled' WHERE id=$1",[op.job_id]);
    await bulkAudit(ctx,'bulk.cancelled',id,'cancelled');
    return ok(`Operación ${id}: pendientes cancelados. Un envío ya en curso puede completarse; consulta el resultado, no se repite.`);
  }
  if(op.status!=='paused')return fail('Solo una operación pausada admite continuar o reintentar fallidos.');
  const uncertain=await ctx.c.query("SELECT 1 FROM bulk_targets t JOIN outbox o ON o.id=t.outbox_id WHERE t.op_id=$1 AND o.status IN ('sending','uncertain')",[id]);
  if(uncertain.rowCount)return fail('Hay envíos inciertos o en curso. Requieren reconciliación; no se repiten.');
  if(action==='retry'){
    const failed=await ctx.c.query<{outbox_id:string}>(`UPDATE bulk_targets SET status='pending',retries=retries+1,detail=NULL,done_at=NULL WHERE op_id=$1 AND status='failed' AND retries<$2 RETURNING outbox_id`,[id,product.bulkMaxManualRetries]);
    if(!failed.rowCount)return fail('No hay fallidos definitivos reintentables.');
    await ctx.c.query("UPDATE outbox SET status='queued',attempts=0,reconcile_attempts=0,provider_msg_id=NULL,last_error=NULL,next_try_at=greatest(next_try_at,clock_timestamp()+$2::int*interval '1 millisecond') WHERE id=ANY($1::bigint[]) AND status='failed'",[failed.rows.map(r=>r.outbox_id),op.params.gapMs]);
  }else if((await ctx.c.query("SELECT 1 FROM bulk_targets WHERE op_id=$1 AND status='failed'",[id])).rowCount)return fail('Hay fallidos definitivos. Usa reintentar fallidos con el identificador.');
  await ctx.c.query("UPDATE bulk_ops SET status='running',reason=NULL,next_at=clock_timestamp()+$2::int*interval '1 millisecond' WHERE id=$1",[id,op.params.gapMs]);
  await bulkAudit(ctx,`bulk.${action}`,id,'running');return ok(`Operación ${id}: ${action==='retry'?'fallidos definitivos habilitados para reintento':'continuación habilitada'}. No se repiten los confirmados.`);
}
