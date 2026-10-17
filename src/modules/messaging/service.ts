import { product } from '../../../config/product.js';
import { argumentHash,openSession } from '../../core/sessions.js';
import { fail,ok,type ToolCtx,type ToolResult } from '../../core/tools.js';
import { discoverDestinations,messagingAllowed } from './access.js';
import { paramsSchema,type Params,type BulkOperation } from './schemas.js';
export async function bulkAudit(ctx:Pick<ToolCtx,'c'|'actor'|'chat'>,action:string,id:string,result:string):Promise<void>{
  await ctx.c.query('INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,$3,$4)',[ctx.actor.id,ctx.chat.id,action,JSON.stringify({id,result,version:product.bulkVersion})]);
}
export function preview(op:BulkOperation):string{
  const p=paramsSchema.parse(op.params);
  return `Operación ${op.id} (${op.kind}).\nContenido exacto: ${p.text}\n${op.kind==='nuclear'?`Cada mensaje añade [n/${p.count}].\n`:''}Destinos: ${p.targets.map(t=>t.label).join(', ')}.\n${p.count} mensajes; mínimo ${p.gapMs/1000} s entre envíos${op.kind==='nuclear'?'':` + jitter de hasta ${product.bulkJitterMs/1000} s`}. Menciones: ${p.mentions.length}.\nTodavía no se ha enviado. ¿Sí o no? Vence en ${product.confirmMinutes} minutos.`;
}
export async function draft(ctx:ToolCtx,kind:BulkOperation['kind'],text:string,tokens:string[]=[],count=1):Promise<ToolResult>{
  if(!await messagingAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id) || (kind==='nuclear' && !ctx.chat.isGroup))return fail('No.');
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('bulk-admission'))");
  const previous=(await ctx.c.query<BulkOperation>('SELECT * FROM bulk_ops WHERE chat_id=$1 AND actor_id=$2 AND source_id=$3 AND kind=$4',[ctx.chat.id,ctx.actor.id,ctx.msg.id,kind])).rows[0];
  if(previous)return ok(`Operación ${previous.id}: ${previous.status}. No se creó otra.`,{id:previous.id});
  const destinations=await discoverDestinations(ctx.c,ctx.config);
  const selected=tokens.map(t=>destinations.find(d=>d.id===t.slice(1)));
  if(kind!=='nuclear' && (selected.some(d=>!d) || !selected.length || (kind==='message' && selected.length!==1)))return fail('Destino inválido o no autorizado. Consulta «bot destinos».');
  const params:Params=paramsSchema.parse({version:product.bulkVersion,text,count:kind==='nuclear'?count:selected.length,gapMs:kind==='nuclear'?product.nuclearGapMs:product.bulkGapMs,targets:kind==='nuclear'?[{target:ctx.chat.id,label:'Grupo actual'}]:selected.map(d=>({target:d!.target_id,label:`d${d!.id}: ${d!.label}`})),mentions:[]});
  const busy=(await ctx.c.query<{n:string}>("SELECT count(*) n FROM bulk_ops WHERE status IN ('draft','queued','running','paused') AND (status<>'draft' OR expires_at>clock_timestamp())")).rows[0]!;
  if(Number(busy.n)>=product.bulkMaxActive)return fail('Ya hay demasiadas operaciones pendientes. Cancela o termina una.');
  const hash=argumentHash(kind,params);
  const op=(await ctx.c.query<BulkOperation>(`INSERT INTO bulk_ops(kind,chat_id,actor_id,source_id,params,args_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7::int*interval '1 minute') RETURNING *`,[kind,ctx.chat.id,ctx.actor.id,ctx.msg.id,JSON.stringify(params),hash,product.confirmMinutes])).rows[0]!;
  const args={id:op.id,hash};await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'confirm',{action:'bulk.confirm',args,hash:argumentHash('bulk.confirm',args)},['sí','no','cancelar']);
  await bulkAudit(ctx,'bulk.draft',op.id,'draft');return ok(preview(op),{id:op.id});
}
export async function confirm(ctx:ToolCtx,id:string,hash:string):Promise<ToolResult>{
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('bulk-admission'))");
  const op=(await ctx.c.query<BulkOperation>('SELECT * FROM bulk_ops WHERE id=$1 AND chat_id=$2 AND actor_id=$3 FOR UPDATE',[id,ctx.chat.id,ctx.actor.id])).rows[0];
  if(!op || !await messagingAllowed(ctx.c,ctx.config,op.chat_id,op.actor_id))return fail('No.');
  if(op.status!=='draft')return ok(`Operación ${id}: ${op.status}. No se duplicó.`,{id});
  if(hash!==op.args_hash || hash!==argumentHash(op.kind,op.params))return fail('La operación cambió. Crea una vista previa nueva.');
  const live=await ctx.c.query('SELECT 1 FROM bulk_ops WHERE id=$1 AND expires_at>clock_timestamp()',[id]);
  if(!live.rowCount){await ctx.c.query("UPDATE bulk_ops SET status='expired' WHERE id=$1",[id]);return fail('La vista previa venció.');}
  const p=paramsSchema.parse(op.params);
  const recent=(await ctx.c.query<{n:string;targets:string}>(`SELECT count(*) FILTER(WHERE confirmed_at>clock_timestamp()-interval '1 hour') n,coalesce(sum((params->>'count')::int),0) targets FROM bulk_ops WHERE confirmed_at>clock_timestamp()-interval '1 day'`)).rows[0]!;
  if(Number(recent.n)>=product.bulkHourlyOps || Number(recent.targets)+p.count>product.bulkDailyTargets)return fail('Límite global de operaciones o mensajes alcanzado.');
  if(op.kind==='nuclear'){
    const active=await ctx.c.query("SELECT 1 FROM bulk_ops WHERE kind='nuclear' AND id<>$1 AND (status IN ('queued','running','paused') AND chat_id=$2 OR confirmed_at>clock_timestamp()-$3::int*interval '1 millisecond' AND chat_id=$2)",[id,op.chat_id,product.nuclearCooldownMs]);
    const hourly=await ctx.c.query("SELECT 1 FROM bulk_ops WHERE kind='nuclear' AND confirmed_at>clock_timestamp()-interval '1 hour'");
    if(active.rowCount || (hourly.rowCount ?? 0)>=product.nuclearHourlyOps)return fail('Nuclear está activo o en cooldown.');
  }
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('media-user'),hashtext($1))",[ctx.actor.id]);
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('media-queue'))");
  const jobs=await ctx.c.query("SELECT 1 FROM jobs WHERE owner_id=$1 AND status IN ('queued','running')",[ctx.actor.id]);
  const queue=await ctx.c.query("SELECT 1 FROM jobs WHERE status IN ('queued','running')");
  if((jobs.rowCount ?? 0)>=product.mediaMaxJobs || (queue.rowCount ?? 0)>=product.mediaQueueLimit)return fail('Límite de trabajos activos alcanzado. Espera o cancela una operación.');
  const job=(await ctx.c.query<{id:string}>("INSERT INTO jobs(kind,payload,chat_id,owner_id,source_message_id) VALUES('bulk',$1,$2,$3,$4) RETURNING id",[JSON.stringify({opId:id}),op.chat_id,op.actor_id,`bulk:${id}`])).rows[0]!;
  for(let i=0;i<p.count;i++){
    const target=p.targets[op.kind==='nuclear'?0:i]!;
    await ctx.c.query('INSERT INTO bulk_targets(op_id,position,target_id,label,text) VALUES($1,$2,$3,$4,$5)',[id,i,target.target,target.label,op.kind==='nuclear'?`${p.text} [${i+1}/${p.count}]`:p.text]);
  }
  await ctx.c.query("UPDATE bulk_ops SET status='queued',confirmed_at=clock_timestamp(),job_id=$2,next_at=clock_timestamp() WHERE id=$1",[id,job.id]);
  await bulkAudit(ctx,'bulk.confirmed',id,'queued');return ok(`Operación ${id} confirmada y en cola: ${p.count} mensajes. Todavía no se confirma ningún envío.`,{id});
}
