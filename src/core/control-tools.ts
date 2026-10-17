import { z } from 'zod';
import { moduleEnabled } from './permissions.js';
import { product } from '../../config/product.js';
import { defineTool,ok,type Tool } from './tools.js';
export const modules=['polls','media','messaging','drive','library','conversation','notes','reminders','memory','web','vision','minecraft','school','xp','games','moderation'] as const;
const base={module:'core',permission:'config.global',scope:'both',modelCallable:false,risk:'write'} as const;
function flagTool(name:string,description:string,example:string,key:string,value:boolean):Tool{
  return defineTool({...base,name,description,examples:[example],args:z.strictObject({}),async run(ctx){
    await ctx.c.query('INSERT INTO system_flags(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()',[key,JSON.stringify(value)]);
    return ok(description);
  }});
}
export const controlTools:Tool[]=[
  flagTool('control.emergency','Apagado de emergencia activado.','bot apagado de emergencia','emergency',true),
  flagTool('control.reactivate','Botsky reactivado.','bot reactiva','emergency',false),
  flagTool('control.maintenance_on','Mantenimiento activado.','bot mantenimiento on','maintenance',true),
  flagTool('control.maintenance_off','Mantenimiento desactivado.','bot mantenimiento off','maintenance',false),
  defineTool({...base,name:'control.modules',description:'Ver o cambiar módulos de este chat.',examples:['bot módulos','bot activa notas aquí','bot desactiva conversación aquí'],args:z.strictObject({module:z.enum(modules).optional(),enabled:z.boolean().optional()}),
    async run(ctx,args){
      if(args.module && args.enabled!==undefined)await ctx.c.query(`UPDATE chats SET settings=jsonb_set(settings,'{modules}',coalesce(settings->'modules','{}'::jsonb)||jsonb_build_object($2::text,$3::boolean)) WHERE id=$1`,[ctx.chat.id,args.module,args.enabled]);
      const r=await ctx.c.query<{settings:{modules?:Record<string,boolean>}}>('SELECT settings FROM chats WHERE id=$1',[ctx.chat.id]);
      return ok(modules.map(m=>`${m}: ${moduleEnabled({...ctx.chat,settings:r.rows[0]?.settings ?? {}},m,ctx.config)?'on':'off'}`).join('\n'));
    }}),
  defineTool({...base,name:'diag.cuota',description:'Consultar consumo diario y estado de Gemini.',examples:['bot diag cuota'],risk:'read',args:z.strictObject({}),async run(ctx){
    const r=await ctx.c.query<{model:string;calls:number;input:number;output:number}>(`SELECT model,count(*)::int AS calls,sum(input_tokens)::int AS input,sum(output_tokens)::int AS output FROM llm_usage WHERE at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles' GROUP BY model`);
    const minute=await ctx.c.query<{calls:number;tokens:number}>(`SELECT count(*)::int AS calls,coalesce(sum(CASE WHEN input_tokens>0 THEN input_tokens ELSE reserved_input_tokens END),0)::int AS tokens FROM llm_usage WHERE at>clock_timestamp()-interval '1 minute'`);
    const usage=minute.rows[0]!;
    return ok(`Límites de Botsky: ${product.llmGlobalRpm} llamadas/min, ${product.llmDailyLimit}/día; entrada ${usage.tokens}/${product.llmInputTokensPerMinute} tokens en el último minuto (incluye reservas pendientes).\nGemini: ${ctx.config.GEMINI_API_KEY && ctx.config.GEMINI_FREE_TIER_CONFIRMED?'configurado':'sin configurar'}\n${r.rows.map(x=>`${x.model}: ${x.calls} llamadas; entrada ${x.input}, salida ${x.output} tokens`).join('\n') || '0 llamadas hoy.'}`);}}),
  defineTool({...base,name:'diag.errores',description:'Ver los últimos 20 errores sanitizados.',examples:['bot diag errores'],risk:'read',args:z.strictObject({}),async run(ctx){const r=await ctx.c.query<{id:string;where_:string;at:Date}>('SELECT id,where_,at FROM error_log ORDER BY id DESC LIMIT 20');return ok(r.rows.map(x=>`#${x.id} ${x.at.toISOString()} ${x.where_}`).join('\n') || 'No hay errores.');}}),
];
