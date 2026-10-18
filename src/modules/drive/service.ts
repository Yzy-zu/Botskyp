import { observer } from '../../observer/index.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Config } from '../../config.js';
import { product } from '../../../config/product.js';
import { fail,ok,type ToolCtx,type ToolResult } from '../../core/tools.js';
import { msgSchema } from '../../wa/types.js';
import { messagingAllowed } from '../messaging/access.js';
import { attachmentSource } from '../school/attachments.js';
export const driveRequest=z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('search'),query:z.string().trim().min(1).max(100)}),
  z.strictObject({operation:z.literal('download'),entryId:z.string().regex(/^[1-9]\d{0,12}$/)}),
  z.strictObject({operation:z.literal('upload'),source:msgSchema.optional(),artifactId:z.uuid().optional()}).refine(a=>Boolean(a.source)!==Boolean(a.artifactId)),
]);
export async function driveAllowed(c:PoolClient,config:Config,chatId:string,actorId:string):Promise<boolean>{
  if(!config.DRIVE_ENABLED || !await messagingAllowed(c,config,chatId,actorId,'drive'))return false;
  return Boolean((await c.query("SELECT 1 FROM chats WHERE id=$1 AND settings->'drive'='true'::jsonb",[chatId])).rowCount);
}
export async function enqueueDrive(ctx:ToolCtx,operation:'search'|'download'|'upload',value?:string,artifactId?:string):Promise<ToolResult>{
  if(!await driveAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))return fail('Drive no está configurado o habilitado en este chat. La biblioteca local sigue disponible.');
  let input:unknown={operation,...(operation==='search'?{query:value}:operation==='download'?{entryId:value}:{})};
  if(operation==='upload' && artifactId){
    if(!(await ctx.c.query('SELECT 1 FROM chat_artifacts WHERE id=$1 AND chat_id=$2 AND actor_id=$3 AND expires_at>clock_timestamp()',[artifactId,ctx.chat.id,ctx.actor.id])).rowCount)return fail('Ese archivo ya no está disponible.');
    input={operation,artifactId};
  }else if(operation==='upload'){
    const source=await attachmentSource(ctx);
    if(!source || source.senderId!==ctx.msg.senderId || source.chatId!==ctx.chat.id)return fail('Adjunta un archivo propio en este chat.');
    input={operation,source};
  }
  const parsed=driveRequest.safeParse(input);if(!parsed.success)return fail('Solicitud Drive inválida.');
  if(operation==='download' && !(await ctx.c.query('SELECT 1 FROM drive_entries WHERE id=$1 AND chat_id=$2 AND actor_id=$3 AND expires_at>clock_timestamp()',[value,ctx.chat.id,ctx.actor.id])).rowCount)return fail('Ese resultado no pertenece a tu consulta vigente en este chat. Busca de nuevo.');
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('media-user'),hashtext($1))",[ctx.actor.id]);
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('media-queue'))");
  const old=(await ctx.c.query<{id:string}>("SELECT id FROM jobs WHERE kind='drive' AND chat_id=$1 AND owner_id=$2 AND source_message_id=$3",[ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0];
  if(old)return ok(`Trabajo Drive #${old.id} ya registrado.`,{jobId:old.id});
  const active=await ctx.c.query("SELECT 1 FROM jobs WHERE owner_id=$1 AND status IN ('queued','running')",[ctx.actor.id]);
  const queued=await ctx.c.query("SELECT 1 FROM jobs WHERE status IN ('queued','running')");
  if((active.rowCount ?? 0)>=product.mediaMaxJobs || (queued.rowCount ?? 0)>=product.mediaQueueLimit)return fail('La cola está ocupada. Espera a que terminen los trabajos.');
  const job=(await ctx.c.query<{id:string}>("INSERT INTO jobs(kind,payload,chat_id,owner_id,source_message_id) VALUES('drive',$1,$2,$3,$4) RETURNING id",[JSON.stringify(parsed.data),ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0]!;
  observer.emit(()=>({eventType:'JOB_QUEUED',stage:'drive.enqueue',jobId:job.id,payload:{id:job.id,kind:'drive',payload:parsed.data,transaction:'pending_commit'}}));
  await ctx.c.query('INSERT INTO drive_operations(job_id) VALUES($1)',[job.id]);
  return ok(`Trabajo Drive #${job.id} en cola. Todavía no se ha subido ni entregado nada.`,{jobId:job.id});
}
