import { randomUUID } from 'node:crypto';
import { defineTool,ok,fail,type Tool } from '../../core/tools.js';
import { argumentHash } from '../../core/sessions.js';
import { callMinecraft,MinecraftError } from './client.js';
import { schemas,writeAction,type Action } from './protocol.js';
import { formatResponse } from './messages.js';
const descriptions:Record<Action,string>={status:'Estado de Bedrock en redspi.',players:'Jugadores actuales de Bedrock.',resources:'Recursos del contenedor (owner).',worlds:'Mundos instalados (owner).',addons:'Inventario de addons (owner).',logs:'Logs recientes con límite (owner).','config-get':'Configuración permitida (owner).','config-set':'Cambiar propiedad permitida; requiere reinicio posterior (owner).',start:'Iniciar Bedrock (owner).',stop:'Detener Bedrock con confirmación (owner).',restart:'Reiniciar Bedrock con confirmación (owner).',backup:'Respaldo verificable de mundos (owner).',console:'Comando Minecraft de allowlist (owner).'};
export const minecraftTools:Tool[]=Object.entries(schemas).map(([name,args])=>{
  const action=name as Action;
  return defineTool({name:`minecraft.${action}`,capability:{produces:'estado/recibo de operación'},module:'minecraft',
    description:descriptions[action],examples:[`bot mc ${action}${action==='logs'?' 30':action==='console'?' time query daytime':action==='config-set'?' pvp false':''}`],
    args,permission:['status','players'].includes(action)?'minecraft.read':'infra.minecraft',
    risk:['stop','restart'].includes(action)?'destructive':writeAction(action)?'write':'read',
    scope:'group',modelCallable:['status','players'].includes(action),
    async run(ctx,args){
      if(!ctx.config.MINECRAFT_ENABLED)return fail('Minecraft no está configurado para redspi.');
      const request={action,args};
      if(!writeAction(action)){
        const id=randomUUID();
        let result;
        try{
          const response=await callMinecraft(request,id);
          result=response.ok?ok(formatResponse(response)):fail(formatResponse(response));
        }catch(error){result=fail(error instanceof MinecraftError && error.kind==='protocol'?'redspi devolvió una respuesta inesperada; no puedo confirmar el estado.':'redspi no responde por SSH o agotó el tiempo. No puedo confirmar el estado.');}
        await ctx.c.query('INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,$3,$4)',[ctx.actor.id,ctx.chat.id,'minecraft.read',JSON.stringify({id,target:'redspi',action,status:result.ok?'observed':'unavailable'})]);
        return result;
      }
      const previous=await ctx.c.query<{id:string}>('SELECT id FROM minecraft_operations WHERE chat_id=$1 AND actor_id=$2 AND source_id=$3',[ctx.chat.id,ctx.actor.id,ctx.msg.id]);
      if(previous.rows[0])return ok(`Solicitud Minecraft ${previous.rows[0].id} ya registrada; no se repetirá.`);
      const id=randomUUID();
      const inserted=await ctx.c.query(`INSERT INTO minecraft_operations(id,chat_id,actor_id,source_id,request) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT DO NOTHING RETURNING id`,[id,ctx.chat.id,ctx.actor.id,ctx.msg.id,JSON.stringify(request)]);
      if(!inserted.rowCount)return fail('Hay una operación Minecraft en curso o incierta. Consulta bot mc operaciones; no iniciaré otra.');
      await ctx.c.query('INSERT INTO audit_log(actor_id,chat_id,action,detail) VALUES($1,$2,$3,$4)',[ctx.actor.id,ctx.chat.id,`minecraft.queued`,JSON.stringify({id,target:'redspi',action,argsHash:argumentHash(action,args),status:'queued'})]);
      return ok(`Solicitud Minecraft ${id} registrada (${action}). Está pendiente; todavía no confirmo ningún cambio.`);
    },
  });
});
