import { z } from 'zod';
import { product } from '../../../config/product.js';
import { defineTool,ok,type Tool } from '../../core/tools.js';
import { daily,level,wallet } from './service.js';
const base={capability:{produces:'XP/nivel/racha'},module:'xp',permission:'xp.use',scope:'group',modelCallable:false,risk:'write'} as const;
export const xpTools:Tool[]=[
  defineTool({...base,name:'xp.balance',capability:{summary:'Consultar saldo, nivel y racha.',produces:'XP/nivel/racha'},risk:'read',description:'Consultar tu saldo actual, nivel y racha.',examples:['bot xp'],args:z.strictObject({}),async run(ctx){const w=await wallet(ctx.c,ctx.actor.id);return ok(`Saldo: ${w.balance} XP. Nivel: ${level(w.balance)}. Racha: ${w.streak}.`);}}),
  defineTool({...base,name:'xp.daily',capability:{summary:'Cobrar recompensa diaria propia.',produces:'recibo XP'},description:'Reclamar premio diario, cada 24 horas.',examples:['bot diario'],args:z.strictObject({}),async run(ctx){const w=await daily(ctx.c,ctx.actor.id,ctx.chat.id,JSON.stringify([ctx.chat.id,ctx.msg.id]),ctx.now);return ok(`Diario registrado. Saldo: ${w.balance} XP. Nivel: ${level(w.balance)}. Racha: ${w.streak}.`);}}),
  defineTool({...base,name:'xp.happy',capability:{summary:'Activar/desactivar Hora Feliz.',produces:'estado'},permission:'chat.configure',description:'Activar Hora Feliz manualmente para este grupo.',examples:['bot hora feliz','bot hora feliz 60','bot hora feliz off'],args:z.strictObject({minutes:z.number().int().min(1).max(product.happyMaxMinutes).optional(),off:z.boolean().optional()}),async run(ctx,args){
    const until=args.off?null:new Date(ctx.now.getTime()+(args.minutes ?? product.happyMinutes)*60_000).toISOString();
    await ctx.c.query("UPDATE chats SET settings=settings||jsonb_build_object('happy_hour_until',$2::text) WHERE id=$1",[ctx.chat.id,until]);
    return ok(until?`Hora Feliz activa hasta ${until}: +${product.xpHappyActivity} XP por mensaje elegible.`:'Hora Feliz desactivada.');
  }}),
];
