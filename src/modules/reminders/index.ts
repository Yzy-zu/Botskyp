import { z } from 'zod';
import { defineTool,ok,fail,type Tool } from '../../core/tools.js';
import { openSession } from '../../core/sessions.js';
import { recurrenceMatchesDue,recurrenceSchema,validateDue,formatDue,ambiguousTime } from './time.js';
import { product } from '../../../config/product.js';
const base={module:'reminders',permission:'chat.use',scope:'both',modelCallable:true} as const;
const body=z.string().trim().min(1).max(product.maxTextChars);
const data=z.strictObject({body:body.optional(),dueAt:z.string().optional(),timezone:z.string().default('America/Mexico_City'),recurrence:recurrenceSchema.optional()});
export const reminderTools:Tool[]=[
  defineTool({...base,name:'reminders.create',description:'Crear recordatorio. No inventar body: si falta contenido, omitirlo para preguntar. dueAt ISO-8601 con offset de timezone; si falta fecha o periodo pedir aclaración. Recurrencia opcional diaria/semanal/mensual.',examples:['bot recuérdame entregar el proyecto','bot recordatorio en 2 minutos revisar horno'],risk:'write',args:data,
    async run(ctx,args){
      if(!args.body){
        await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'clarify',{action:'reminders.create',args,missing:'body'},['contenido','cancelar']);
        return ok('¿Qué quieres que te recuerde?');
      }
      if(!args.dueAt || ambiguousTime(ctx.msg.text)){
        await openSession(ctx.c,ctx.actor.id,ctx.chat.id,'clarify',{action:'reminders.create',args},['fecha','cancelar']);
        return ok(args.dueAt?'¿A las ocho de la mañana o de la tarde/noche?':'¿Cuándo quieres que te lo recuerde?');
      }
      const due=validateDue(args.dueAt,args.timezone,ctx.now);if(!due)return fail('La fecha debe ser futura, con zona y hora válidas.');
      if(args.recurrence && !recurrenceMatchesDue(due,args.timezone,args.recurrence))return fail('La fecha inicial no coincide con la recurrencia.');
      const r=await ctx.c.query<{id:string}>('INSERT INTO reminders(chat_id,owner_id,body,due_at,timezone,recurrence) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[ctx.chat.id,ctx.actor.id,args.body,due,args.timezone,args.recurrence?JSON.stringify(args.recurrence):null]);
      await ctx.c.query("UPDATE sessions SET status='done',version=version+1 WHERE owner_id=$1 AND chat_id=$2 AND kind='clarify' AND status='active' AND state->>'action'='reminders.create'",[ctx.actor.id,ctx.chat.id]);
      return ok(`Recordatorio #${r.rows[0]!.id}: ${args.body}\n${formatDue(due,args.timezone)}\nDestino: este chat.${args.recurrence?`\nRecurrencia: ${JSON.stringify(args.recurrence)}`:''}`,{id:r.rows[0]!.id,dueAt:due.toISOString()});}}),
  defineTool({...base,name:'reminders.list',description:'Consultar tus recordatorios pendientes de este chat.',examples:['bot recordatorios'],risk:'read',args:z.strictObject({}),
    async run(ctx){const r=await ctx.c.query<{id:string;body:string;due_at:Date;timezone:string;status:string}>("SELECT * FROM reminders WHERE chat_id=$1 AND owner_id=$2 AND status IN ('pending','queued') ORDER BY due_at LIMIT $3",[ctx.chat.id,ctx.actor.id,product.reminderResults]);
      return ok(r.rows.map(x=>`#${x.id}: ${x.body}\n${formatDue(x.due_at,x.timezone)} · ${x.status}`).join('\n') || 'No tienes recordatorios pendientes.');}}),
  defineTool({...base,name:'reminders.edit',description:'Modificar contenido, fecha y recurrencia de un recordatorio propio pendiente.',examples:['bot recordatorio edita 2 2026-12-01T08:00:00-06:00 nuevo texto'],risk:'write',args:data.extend({id:z.string().regex(/^\d+$/),body}),
    async run(ctx,args){const due=args.dueAt?validateDue(args.dueAt,args.timezone,ctx.now):null;if(!due)return fail('Indica una fecha futura con zona válida.');
      if(args.recurrence && !recurrenceMatchesDue(due,args.timezone,args.recurrence))return fail('La fecha inicial no coincide con la recurrencia.');
      const r=await ctx.c.query("UPDATE reminders SET body=$4,due_at=$5,timezone=$6,recurrence=$7 WHERE id=$1 AND chat_id=$2 AND owner_id=$3 AND status='pending'",[args.id,ctx.chat.id,ctx.actor.id,args.body,due,args.timezone,args.recurrence?JSON.stringify(args.recurrence):null]);
      return r.rowCount?ok(`Actualicé #${args.id}: ${args.body}\n${formatDue(due,args.timezone)}\nDestino: este chat.`):fail('No existe un recordatorio propio pendiente con ese ID.');}}),
  defineTool({...base,name:'reminders.cancel',description:'Cancelar un recordatorio propio pendiente.',examples:['bot recordatorio cancela 2'],risk:'write',args:z.strictObject({id:z.string().regex(/^\d+$/)}),
    async run(ctx,args){const r=await ctx.c.query("UPDATE reminders SET status='cancelled' WHERE id=$1 AND chat_id=$2 AND owner_id=$3 AND status='pending'",[args.id,ctx.chat.id,ctx.actor.id]);return r.rowCount?ok(`Cancelé el recordatorio #${args.id}.`):fail('No existe un recordatorio propio pendiente con ese ID.');}}),
];
