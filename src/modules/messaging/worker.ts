import { observer } from '../../observer/index.js';
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { product } from '../../../config/product.js';
import { transaction,type Db } from '../../db/client.js';
import type { Config } from '../../config.js';
import { argumentHash } from '../../core/sessions.js';
import { messagingAllowed,destinationAllowed } from './access.js';
import { stopPending } from './controls.js';
import { paramsSchema,type BulkOperation } from './schemas.js';
type Target={id:string;position:number;target_id:string;text:string;status:string;outbox_id:string|null;outbox_status:string|null;sent_at:Date|null;last_error:string|null};
async function notice(c:PoolClient,op:BulkOperation,key:string,text:string):Promise<void>{
  await c.query('INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[op.chat_id,JSON.stringify({text:`Operación ${op.id}: ${text}`,sourceId:op.source_id}),`bulk:${op.id}:${key}`]);
}
export async function advanceBulk(db:Db,config:Config):Promise<boolean>{
  return transaction(db,async c=>{
    await c.query("UPDATE bulk_ops SET status='expired' WHERE status='draft' AND expires_at<=clock_timestamp()");
    const op=(await c.query<BulkOperation>(`SELECT * FROM bulk_ops WHERE next_at<=clock_timestamp() AND status IN ('queued','running','paused','cancelled') AND (status<>'cancelled' OR EXISTS(SELECT 1 FROM bulk_targets t JOIN outbox o ON o.id=t.outbox_id WHERE t.op_id=bulk_ops.id AND t.status IN ('pending','uncertain') AND o.status IN ('sent','failed','uncertain'))) ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if(!op)return false;
    return observer.source({...(op.job_id?{jobId:op.job_id}:{}),chatId:op.chat_id,actorId:op.actor_id,sourceMessageId:op.source_id},async()=>{
    observer.bindClient(c,observer.ids());
    if(op.status==='queued')observer.emit(()=>({eventType:'JOB_CLAIMED',stage:'bulk.worker',payload:{operation:op}}));
    const p=paramsSchema.parse(op.params);
    if(argumentHash(op.kind,p)!==op.args_hash)throw new Error('bulk_hash_mismatch');
    const targets=(await c.query<Target>(`SELECT t.*,o.status outbox_status,o.sent_at,o.last_error FROM bulk_targets t LEFT JOIN outbox o ON o.id=t.outbox_id WHERE op_id=$1 ORDER BY position`,[op.id])).rows;
    for(const t of targets){
      if(t.status==='skipped')continue;
      const status=t.outbox_status==='sent'?'sent':t.outbox_status==='failed'?'failed':t.outbox_status==='uncertain'?'uncertain':t.status;
      if(status==='sent' && t.status!=='sent' && t.sent_at)await c.query("UPDATE bulk_ops SET next_at=greatest(next_at,$2::timestamptz+$3::int*interval '1 millisecond') WHERE id=$1",[op.id,t.sent_at,p.gapMs+(op.kind==='nuclear'?0:randomInt(product.bulkJitterMs+1))]);
      if(status!==t.status){
        observer.emit(()=>({eventType:'BUSINESS_MUTATION',stage:'bulk.target_result',payload:{opId:op.id,target:t,status,transaction:'pending_commit'}}));
        await c.query('UPDATE bulk_targets SET status=$2,detail=$3,done_at=CASE WHEN $2 IN (\'sent\',\'failed\') THEN clock_timestamp() ELSE NULL END WHERE id=$1',[t.id,status,t.last_error]);
        await c.query("INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,'bulk.target_result',$3)",[op.actor_id,op.chat_id,JSON.stringify({id:op.id,targetRef:t.id,result:status})]);
      }
      t.status=status;
    }
    const sent=targets.filter(t=>t.status==='sent').length;
    const failed=targets.filter(t=>t.status==='failed').length;
    const uncertain=targets.filter(t=>t.status==='uncertain').length;
    if(op.status==='cancelled'){await c.query("UPDATE bulk_ops SET next_at=clock_timestamp()+interval '1 second' WHERE id=$1",[op.id]);return false;}
    if(!await messagingAllowed(c,config,op.chat_id,op.actor_id)){
      await stopPending(c,op.id,'bulk_permission_revoked');
      await c.query("UPDATE bulk_ops SET status='cancelled',reason='permission_revoked',finished_at=clock_timestamp() WHERE id=$1",[op.id]);
      await c.query("UPDATE jobs SET status='failed',error='permission_revoked' WHERE id=$1",[op.job_id]);return true;
    }
    if(failed || uncertain){
      if(op.status!=='paused')observer.emit(()=>({eventType:'JOB_FAILED',stage:'bulk.paused',payload:{opId:op.id,sent,failed,uncertain}}));
      if(op.status!=='paused')await c.query("INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,'bulk.paused',$3)",[op.actor_id,op.chat_id,JSON.stringify({id:op.id,sent,failed,uncertain})]);
      await c.query("UPDATE bulk_ops SET status='paused',reason=$2,next_at=clock_timestamp()+interval '1 second' WHERE id=$1",[op.id,uncertain?'uncertain':'failed']);
      await notice(c,op,'paused',`pausada: ${sent} confirmados por proveedor, ${failed} fallidos, ${uncertain} inciertos. No reenvío automático. Consulta «bot operaciones».`);return false;
    }
    if(op.status==='paused'){await c.query("UPDATE bulk_ops SET next_at=clock_timestamp()+interval '1 second' WHERE id=$1",[op.id]);return false;}
    if(sent===targets.length){
      await c.query("INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,'bulk.done',$3)",[op.actor_id,op.chat_id,JSON.stringify({id:op.id,sent})]);
      await c.query("UPDATE bulk_ops SET status='done',finished_at=clock_timestamp() WHERE id=$1",[op.id]);
      await c.query("UPDATE jobs SET status='done',result=$2 WHERE id=$1",[op.job_id,JSON.stringify({confirmed:sent})]);
      observer.emit(()=>({eventType:'JOB_COMPLETED',stage:'bulk.worker',payload:{opId:op.id,sent,total:targets.length,transaction:'pending_commit'}}));
      await notice(c,op,'done',`${sent}/${targets.length} envíos confirmados por proveedor.`);return true;
    }
    if(sent && sent%product.bulkProgressEvery===0)await notice(c,op,`progress:${sent}`,`${sent}/${targets.length} confirmados por proveedor; continúa pendiente.`);
    const next=targets.find(t=>t.status==='pending');
    if(!next || next.outbox_id)return false;
    const last=targets[next.position-1];
    if(last && (!last.sent_at || Date.now()<last.sent_at.getTime()+p.gapMs))return false;
    const due=await c.query('SELECT 1 FROM bulk_ops WHERE id=$1 AND next_at<=clock_timestamp()',[op.id]);if(!due.rowCount)return false;
    const row=(await c.query<{id:string}>(`INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,'bulk_text',$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,[next.target_id,JSON.stringify({text:next.text,sourceId:op.kind==='nuclear'?op.source_id:'',opId:op.id,targetId:next.id}),`bulk:${op.id}:target:${next.id}`])).rows[0]!;
    observer.emit(()=>({eventType:'OUTBOX_QUEUED',stage:'bulk.worker',payload:{outboxId:row.id,target:next,opId:op.id,transaction:'pending_commit'}}));
    await c.query('UPDATE bulk_targets SET outbox_id=$2 WHERE id=$1',[next.id,row.id]);
    const gap=p.gapMs+(op.kind==='nuclear'?0:randomInt(product.bulkJitterMs+1));
    await c.query("UPDATE bulk_ops SET status='running',next_at=clock_timestamp()+$2::int*interval '1 millisecond' WHERE id=$1",[op.id,gap]);
    await c.query("UPDATE jobs SET status='running' WHERE id=$1 AND status='queued'",[op.job_id]);
    observer.emit(()=>({eventType:'JOB_STARTED',stage:'bulk.worker',payload:{opId:op.id,outboxId:row.id,jobId:op.job_id,target:next}}));return true;
    });
  });
}
/** Claim under the operation lock: cancellation and claiming cannot pass each other. */
export async function claimBulk(db:Db,config:Config,row:{id:string;chat_id:string;payload:unknown}):Promise<boolean>{
  return transaction(db,async c=>{
    const op=(await c.query<BulkOperation>(`SELECT b.* FROM bulk_ops b JOIN bulk_targets t ON t.op_id=b.id WHERE t.outbox_id=$1 FOR UPDATE OF b`,[row.id])).rows[0];
    if(!op || op.status!=='running')return false;
    const target=(await c.query<Target>('SELECT * FROM bulk_targets WHERE op_id=$1 AND outbox_id=$2',[op.id,row.id])).rows[0];
    const p=paramsSchema.parse(op.params);
    const payload=row.payload as Record<string,unknown>;
    const authorized=target && target.target_id===row.chat_id && payload['opId']===op.id && payload['targetId']===target.id && payload['text']===target.text && payload['sourceId']===(op.kind==='nuclear'?op.source_id:'') && argumentHash(op.kind,p)===op.args_hash && await messagingAllowed(c,config,op.chat_id,op.actor_id) && await destinationAllowed(c,config,target.target_id);
    if(!authorized){await c.query("UPDATE outbox SET status='failed',last_error='bulk_not_allowed' WHERE id=$1 AND status='queued'",[row.id]);return false;}
    const claimed=await c.query("UPDATE outbox SET status='sending',sending_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1 AND status='queued' RETURNING id",[row.id]);
    return Boolean(claimed.rowCount);
  });
}
