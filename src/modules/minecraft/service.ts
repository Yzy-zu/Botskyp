import { observer } from '../../observer/index.js';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { transaction,type Db } from '../../db/client.js';
import { actorFor,moduleEnabled,permitted,type Chat } from '../../core/permissions.js';
import { defineTool,ok } from '../../core/tools.js';
import { callMinecraft,type MinecraftClient } from './client.js';
import { requestSchema,type Request } from './protocol.js';
import { formatResponse } from './messages.js';
type Operation={id:string;chat_id:string;actor_id:string;source_id:string;request:Request;status:string};
export const minecraftOperationTool=defineTool({name:'minecraft.operations',capability:{produces:'estado de operaciones'},module:'minecraft',permission:'infra.minecraft',scope:'group',modelCallable:false,risk:'read',description:'Últimas operaciones Minecraft y resultados inciertos (owner).',examples:['bot mc operaciones'],args:z.strictObject({}),async run(ctx){
  const rows=await ctx.c.query<Operation>('SELECT id,status,request FROM minecraft_operations ORDER BY created_at DESC LIMIT 10');
  return ok(rows.rows.map(r=>`${r.id}: ${r.request.action}, ${r.status}`).join('\n') || 'No hay operaciones Minecraft.');
}});
async function finish(db:Db,op:Operation,status:'done'|'review'|'cancelled',message:string,response:unknown=null):Promise<void>{
  await transaction(db,async c=>{
    await c.query('UPDATE minecraft_operations SET status=$2,response=$3,finished_at=clock_timestamp() WHERE id=$1',[op.id,status,JSON.stringify(response)]);
    await c.query('INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,$3,$4)',[op.actor_id,op.chat_id,'minecraft.result',JSON.stringify({id:op.id,target:'redspi',action:op.request.action,status,response})]);
    // This reference is only emitted back to its enabled origin by the existing outbox.
    await c.query(`INSERT INTO outbox(chat_id,payload,dedupe_key) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING`,[op.chat_id,JSON.stringify({text:`Minecraft ${op.id}: ${message}`,sourceId:op.source_id}),`minecraft:${op.id}:result`]);
  });
}
export async function recoverMinecraft(db:Db):Promise<void>{
  const rows=await db.query<Operation>("SELECT * FROM minecraft_operations WHERE status='sending'");
  for(const op of rows.rows)await finish(db,op,'review','La app se reinició durante la acción; resultado incierto. No se repetirá. Requiere revisión técnica.');
}
export async function tickMinecraft(db:Db,config:Config,client:MinecraftClient=callMinecraft):Promise<void>{
  // Claim in one transaction; the global active-row index excludes a second writer.
  const op=await transaction(db,async c=>{
    const row=(await c.query<Operation>("SELECT * FROM minecraft_operations WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
    if(!row)return undefined;
    const chat=(await c.query<Chat>('SELECT id,is_group AS "isGroup",enabled,settings FROM chats WHERE id=$1',[row.chat_id])).rows[0];
    const actor=await actorFor(c,{id:row.source_id,chatId:row.chat_id,senderId:row.actor_id,isGroup:true,ts:new Date(),text:'',fromMe:false,mentions:[],attachments:[]},config);
    const flags=await c.query("SELECT 1 FROM system_flags WHERE key IN ('emergency','maintenance') AND value='true'::jsonb");
    if(!config.MINECRAFT_ENABLED || !chat || !chat.isGroup || !permitted(actor,chat,'infra.minecraft') || !moduleEnabled(chat,'minecraft',config) || flags.rowCount)return {...row,status:'cancelled'};
    requestSchema.parse(row.request);
    await c.query("UPDATE minecraft_operations SET status='sending',started_at=clock_timestamp() WHERE id=$1",[row.id]);
    await c.query('INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,$3,$4)',[row.actor_id,row.chat_id,'minecraft.sending',JSON.stringify({id:row.id,target:'redspi',action:row.request.action})]);
    return row;
  });
  if(!op)return;
  return observer.source({chatId:op.chat_id,actorId:op.actor_id,sourceMessageId:op.source_id},async()=>{
  observer.emit(()=>({eventType:'BUSINESS_MUTATION',stage:'minecraft.claim',payload:{operation:op}}));
  if(op.status==='cancelled'){await finish(db,op,'cancelled','Cancelada antes del envío: módulo, permisos o controles ya no permiten ejecutarla.');return;}
  // Any failure after committing sending might have changed the remote server.
  try{
    observer.emit(()=>({eventType:'PROCESS_STARTED',stage:'minecraft.gateway',payload:{operation:op}}));
    const response=await client(op.request,op.id);
    observer.emit(()=>({eventType:'PROCESS_OUTPUT',stage:'minecraft.gateway',payload:{operationId:op.id,response}}));
    const uncertain=['uncertain','conflict','failed'].includes(response.code);
    await finish(db,op,uncertain?'review':'done',formatResponse(response),response);
  }catch(error){observer.emit({eventType:'TOOL_ERROR',stage:'minecraft.gateway',payload:{error,operationId:op.id}});await finish(db,op,'review','redspi no responde, hubo un timeout SSH o una respuesta inesperada. Resultado incierto; no repetiré la acción.');}
  });
}
