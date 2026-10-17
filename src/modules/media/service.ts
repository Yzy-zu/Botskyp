import { z } from 'zod';
import { product } from '../../../config/product.js';
import type { ToolCtx,ToolResult } from '../../core/tools.js';
import { fail,ok } from '../../core/tools.js';
import { openSession,type Session,closeSession } from '../../core/sessions.js';
import { attachmentSource } from '../school/attachments.js';
import { acceptedUrl } from './network.js';
import { requestSchema } from './catalog.js';
import { searchMedia,choiceSchema } from './sources.js';
import { mediaAllowed } from './access.js';
import { msgSchema } from '../../wa/types.js';
const stateSchema=z.discriminatedUnion('flow',[
  z.strictObject({flow:z.literal('selection'),choices:z.array(choiceSchema).max(product.searchResults)}),
  z.strictObject({flow:z.literal('collection'),operation:z.enum(['images_pdf','pdf_merge']),sources:z.array(msgSchema).max(product.mediaMaxFiles)}),
]);
export async function enqueueMedia(ctx:ToolCtx,input:z.infer<typeof requestSchema>,sources:unknown[]=[]):Promise<ToolResult>{
  const args=requestSchema.parse(input);
  if(!await mediaAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))return fail('No.');
  if((args.operation==='download')!==Boolean(args.url))return fail('La descarga necesita una URL permitida; las conversiones usan el adjunto de este chat.');
  if(args.url){try{args.url=acceptedUrl(args.url).href;}catch{return fail('Esa URL no está permitida. Solo archivos directos de Wikimedia Commons.');}}
  if((args.operation==='qr_create' || args.operation==='speak') && !args.text?.trim())return fail('Falta el texto.');
  if(args.operation==='speak' && (args.text?.length ?? 0)>product.mediaSpeechChars)return fail(`La voz admite hasta ${product.mediaSpeechChars} caracteres.`);
  if(args.operation==='qr_create' && (args.text?.length ?? 0)>product.mediaQrChars)return fail(`El QR admite hasta ${product.mediaQrChars} caracteres.`);
  if(args.operation==='pdf_crop' && (!args.start || !args.end || args.start>args.end))return fail('Indica la primera y última página, dentro de 1–20.');
  if(!args.url && !['qr_create','speak'].includes(args.operation) && !sources.length){
    const source=await attachmentSource(ctx);
    if(source)sources=[source];
    else if(ctx.msg.quoted){
      const retained=(await ctx.c.query<{id:string}>(`SELECT a.id FROM outbox o JOIN media_attachments a ON a.id=(o.payload->>'attachmentId')::uuid
        WHERE o.kind='media_result' AND o.status='sent' AND o.provider_msg_id=$1 AND o.chat_id=$2 AND a.chat_id=$2
        AND a.owner_id=$3 AND a.data IS NOT NULL AND a.expires_at>clock_timestamp() LIMIT 1`,[ctx.msg.quoted.id,ctx.chat.id,ctx.actor.id])).rows[0];
      if(retained)sources=[{storedId:retained.id}];
    }
    if(!sources.length)return fail('No tengo ese archivo disponible en este chat. Reenvíalo con la solicitud.');
  }
  // Actor lock enforces the active-job limit across chats, concurrent requests and replay.
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('media-user'),hashtext($1))",[ctx.actor.id]);
  const previous=(await ctx.c.query<{id:string}>('SELECT id FROM jobs WHERE kind=\'media\' AND chat_id=$1 AND owner_id=$2 AND source_message_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0];
  if(previous)return ok(`La solicitud ya está registrada como trabajo #${previous.id}; consulta su estado.`,{jobId:previous.id});
  const active=(await ctx.c.query<{n:string}>("SELECT count(*) n FROM jobs WHERE owner_id=$1 AND status IN ('queued','running')",[ctx.actor.id])).rows[0]!;
  if(Number(active.n)>=product.mediaMaxJobs)return fail(`Ya tienes ${product.mediaMaxJobs} trabajos activos. Espera a que terminen.`);
  // Serialize queue capacity as well, without involving the worker's processing lock.
  await ctx.c.query("SELECT pg_advisory_xact_lock(hashtext('media-queue'))");
  const total=(await ctx.c.query<{n:string}>("SELECT count(*) n FROM jobs WHERE status IN ('queued','running')")).rows[0]!;
  if(Number(total.n)>=product.mediaQueueLimit)return fail('La cola multimedia está llena. Intenta más tarde.');
  const row=(await ctx.c.query<{id:string}>(`INSERT INTO jobs(kind,payload,chat_id,owner_id,source_message_id) VALUES('media',$1,$2,$3,$4) RETURNING id`,[JSON.stringify({...args,sources}),ctx.chat.id,ctx.actor.id,ctx.msg.id])).rows[0]!;
  return ok(`Trabajo #${row.id} en cola. Lo procesaré y publicaré el resultado aquí; todavía no se ha entregado.`,{jobId:row.id});
}
export async function beginCollection(ctx:ToolCtx,operation:'images_pdf'|'pdf_merge'):Promise<ToolResult>{
  if(!await mediaAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))return fail('No.');
  const source=await attachmentSource(ctx);
  await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'media',{flow:'collection',operation,sources:source?[source]:[]},['archivo','terminar','cancelar']);
  return ok('Voy a reunir los archivos de este chat. Envía los que faltan y escribe «terminar». Máximo 10 archivos; vence tras 5 minutos de inactividad.');
}
export async function beginSearch(ctx:ToolCtx,query:string,type:'audio'|'video'):Promise<ToolResult>{
  if(!await mediaAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))return fail('No.');
  try{
    const choices=await searchMedia(query,type);
    if(!choices.length)return fail('No encontré archivos compatibles dentro de los límites en Wikimedia Commons.');
    await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'media',{flow:'selection',choices},choices.map((_,i)=>String(i+1)));
    return ok(`${choices.map((c,i)=>`${i+1}. ${c.title} (${c.size} bytes)\n${c.page}`).join('\n')}\nElige un número en 5 minutos. La fuente/licencia se conserva con el archivo.`);
  }catch{return fail('Wikimedia Commons no está disponible. No descargué nada.');}
}
export async function continueMedia(ctx:ToolCtx,session:Session,text:string):Promise<string>{
  if(!await mediaAllowed(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id))return 'No.';
  const parsed=stateSchema.safeParse(session.state);if(!parsed.success)return 'La selección no es válida.';
  const state=parsed.data;
  if(/^(cancelar|no)[.!]?$/iu.test(text)){await closeSession(ctx.c,session,'cancelled');return 'Interacción cancelada.';}
  if(state.flow==='selection'){
    const index=Number(text)-1;const choice=Number.isInteger(index)?state.choices[index]:undefined;
    if(!choice)return 'Elige uno de los números disponibles.';
    if(!await closeSession(ctx.c,session,'done'))return 'La selección venció.';
    const result=await enqueueMedia(ctx,{operation:'download',url:choice.url,text:`Fuente: ${choice.page}`});return result.ok?result.reply:result.message;
  }
  if(/^terminar[.!]?$/iu.test(text)){
    if(!state.sources.length)return 'Envía al menos un archivo.';
    if(!await closeSession(ctx.c,session,'done'))return 'La colección venció.';
    const result=await enqueueMedia(ctx,{operation:state.operation},state.sources);return result.ok?result.reply:result.message;
  }
  if(!ctx.msg.attachments.length)return 'Envía un archivo o escribe «terminar».';
  if(state.sources.length>=product.mediaMaxFiles)return 'Ya hay 10 archivos. Escribe «terminar».';
  if(!state.sources.some(s=>s.id===ctx.msg.id))state.sources.push(ctx.msg);
  await ctx.c.query(`UPDATE sessions SET state=$3,version=version+1,expires_at=clock_timestamp()+$4::int*interval '1 minute'
    WHERE id=$1 AND version=$2 AND status='active' AND expires_at>clock_timestamp()`,[session.id,session.version,JSON.stringify(state),product.sessionMinutes]);
  return `Archivo ${state.sources.length} recibido para la colección. Escribe «terminar» cuando estén todos.`;
}
