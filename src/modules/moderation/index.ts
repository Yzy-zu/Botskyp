import { z } from 'zod';
import { product } from '../../../config/product.js';
import { defineTool,fail,ok,type Tool } from '../../core/tools.js';
import { actorFor } from '../../core/permissions.js';
import { changeWarn,warnCount } from './service.js';
const base={capability:{produces:'warns'},module:'moderation',permission:'moderation.act',scope:'group',modelCallable:false,risk:'write'} as const;
export const moderationTools:Tool[]=[
  defineTool({...base,name:'moderation.warns',capability:{summary:'Consultar warns propios.',produces:'warns'},permission:'games.use',risk:'read',description:'Consultar tus warns en este grupo.',examples:['bot warns'],args:z.strictObject({}),async run(ctx){return ok(`Tienes ${await warnCount(ctx.c,ctx.chat.id,ctx.actor.id)} warns aquí.`);}}),
  defineTool({...base,name:'moderation.change',capability:{summary:'Poner/quitar warn a mención real.',produces:'recibo'},description:'Poner o quitar un warn a una mención auténtica del mensaje.',examples:['bot warn @persona','bot quita warn @persona'],args:z.strictObject({remove:z.boolean()}),async run(ctx,args){
    const mentions=ctx.msg.mentions.filter(id=>!ctx.config.BOT_JIDS.includes(id));
    if(mentions.length!==1)return fail('Menciona a una sola persona del grupo.');
    const target=await actorFor(ctx.c,{...ctx.msg,senderId:mentions[0]!},ctx.config);
    if(!/^\d+@s\.whatsapp\.net$/.test(target.id))return fail('No puedo verificar esa identidad.');
    const member=await ctx.c.query('SELECT 1 FROM group_memberships WHERE chat_id=$1 AND user_id=$2 AND active AND last_seen_at>clock_timestamp()-$3::int*interval \'1 millisecond\'',[ctx.chat.id,target.id,product.membershipMaxAgeMs]);
    if(!member.rowCount)return fail('No puedo verificar su membresía actual.');
    const count=await changeWarn(ctx.c,ctx.chat.id,target.id,ctx.actor.id,ctx.msg.id,args.remove);
    return ok(`${target.id}: ${count} warns. Los warns manuales no ejecutan expulsiones.`);
  }}),
  defineTool({...base,name:'moderation.config',capability:{summary:'Configurar consecuencias de ruleta.',produces:'configuración'},description:'Configurar consecuencias de ruleta y minutos de castigo.',examples:['bot ruleta consecuencias on','bot ruleta consecuencias off','bot ruleta castigo 15'],args:z.strictObject({enabled:z.boolean().optional(),minutes:z.number().int().min(1).max(product.rouletteMaxPunishmentMinutes).optional()}),async run(ctx,args){
    if(args.enabled!==undefined)await ctx.c.query("UPDATE chats SET settings=settings||jsonb_build_object('roulette_warns',$2::boolean) WHERE id=$1",[ctx.chat.id,args.enabled]);
    if(args.minutes!==undefined)await ctx.c.query("UPDATE chats SET settings=settings||jsonb_build_object('roulette_punishment_minutes',$2::int) WHERE id=$1",[ctx.chat.id,args.minutes]);
    const r=(await ctx.c.query<{settings:Record<string,unknown>}>('SELECT settings FROM chats WHERE id=$1',[ctx.chat.id])).rows[0]!.settings;
    return ok(`Consecuencias de ruleta: ${r['roulette_warns']===true?'on':'off'}. Castigo: ${r['roulette_punishment_minutes'] ?? product.roulettePunishmentMinutes} minutos. Aplica a lobbies nuevos; owner/admin inmunes a expulsión.`);
  }}),
];
