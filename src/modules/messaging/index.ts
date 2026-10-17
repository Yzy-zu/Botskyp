import { z } from 'zod';
import { product } from '../../../config/product.js';
import { defineTool,ok,fail,type Tool } from '../../core/tools.js';
import { discoverDestinations } from './access.js';
import { draft,confirm } from './service.js';
import { manageOperation } from './controls.js';
import { draftSchema,nuclearSchema,operationSchema,confirmSchema } from './schemas.js';
const base={module:'messaging',permission:'bulk.broadcast',scope:'both',modelCallable:false,risk:'write'} as const;
export const messagingTools:Tool[]=[
  defineTool({...base,name:'messaging.destinations',risk:'read',description:'Destinos autorizados resueltos por backend (owner).',examples:['bot destinos'],args:z.strictObject({}),async run(ctx){const rows=await discoverDestinations(ctx.c,ctx.config);return ok(rows.map(d=>`d${d.id}: ${d.label}${d.is_group?' (grupo)':' (privado)'}`).join('\n') || 'Sin destinos disponibles.');}}),
  defineTool({...base,name:'messaging.send',description:'Preparar un mensaje a un destino autorizado (owner); requiere confirmación.',examples:['bot enviar d1 | Texto exacto'],args:draftSchema,run:(ctx,a)=>draft(ctx,'message',a.text,a.destinations)}),
  defineTool({...base,name:'bulk.broadcast',description:'Preparar difusión explícita (owner); requiere vista previa y confirmación.',examples:['bot difundir d1,d2 | Texto exacto'],args:draftSchema,run:(ctx,a)=>draft(ctx,'broadcast',a.text,a.destinations)}),
  defineTool({...base,name:'bulk.nuclear',permission:'bulk.nuclear',scope:'group',description:'Ráfaga owner-only de 5–10 mensajes; nunca expulsa.',examples:['bot nuclear 8 | Atención, grupo'],args:nuclearSchema,run:(ctx,a)=>draft(ctx,'nuclear',a.text,[],a.count)}),
  defineTool({...base,name:'bulk.confirm',risk:'destructive',description:'Confirmar la vista previa vigente de una operación (owner).',examples:['sí (solo tras la vista previa)'],args:confirmSchema,run:(ctx,a)=>confirm(ctx,a.id,a.hash)}),
  defineTool({...base,name:'bulk.cancel',description:'Cancelar pendientes de una operación del chat (owner).',examples:['bot operacion cancelar <id>'],args:operationSchema,run:(ctx,a)=>manageOperation(ctx,a.id,'cancel')}),
  defineTool({...base,name:'bulk.retry',description:'Reintentar solo fallidos definitivos (owner).',examples:['bot reintentar fallidos <id>'],args:operationSchema,run:(ctx,a)=>manageOperation(ctx,a.id,'retry')}),
  defineTool({...base,name:'bulk.resume',description:'Continuar pendientes tras reconciliar una pausa (owner).',examples:['bot operacion continuar <id>'],args:operationSchema,run:(ctx,a)=>manageOperation(ctx,a.id,'resume')}),
  defineTool({...base,name:'bulk.status',risk:'read',description:'Estado y resultados por objetivo del chat (owner).',examples:['bot operaciones','bot operacion <id>'],args:z.strictObject({id:z.uuid().optional()}),async run(ctx,a){
    const ops=(await ctx.c.query<{id:string;kind:string;status:string}>('SELECT id,kind,status FROM bulk_ops WHERE chat_id=$1 AND actor_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC LIMIT $4',[ctx.chat.id,ctx.actor.id,a.id ?? null,product.bulkMaxTargets])).rows;
    if(a.id && !ops.length)return fail('No.');const lines:string[]=[];for(const op of ops){const targets=(await ctx.c.query<{position:number;label:string;status:string}>('SELECT position,label,status FROM bulk_targets WHERE op_id=$1 ORDER BY position',[op.id])).rows;lines.push(`${op.id} ${op.kind}: ${op.status}\n${targets.map(t=>`${t.position+1}. ${t.label}: ${t.status}`).join('\n')}`);}return ok(lines.join('\n\n') || 'Sin operaciones.');
  }}),
];
