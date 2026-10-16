import { z } from 'zod';
import { DateTime } from 'luxon';
import type { PoolClient } from 'pg';
import type { Config } from '../../config.js';
import { transaction,type Db } from '../../db/client.js';
import { moduleEnabled,type Chat } from '../../core/permissions.js';
import { product } from '../../../config/product.js';
import { schoolTool } from './access.js';
import { ok,fail,type Tool } from '../../core/tools.js';
import { lockSchool } from './schedule.js';
import { schoolZone,summarySchema,nextSummary,weekdays,type SummarySchedule } from './schemas.js';
import { formatDue } from '../reminders/time.js';
export async function schoolDestination(c:Pick<PoolClient,'query'>,config:Config,chatId:string,actorId:string,manage=true):Promise<boolean>{
  // Existing Evolution transport and inbox keep the production barrier at Lab.
  if(chatId!==config.LAB_CHAT_ID)return false;
  const row=(await c.query<{is_group:boolean;enabled:boolean;settings:Chat['settings']}>('SELECT * FROM chats WHERE id=$1',[chatId])).rows[0];
  if(!row?.is_group || !row.enabled || !moduleEnabled({id:chatId,isGroup:true,...row},'school',config))return false;
  if(config.OWNER_JIDS.includes(actorId) && !actorId.endsWith('@lid'))return true;
  if(manage && actorId.endsWith('@lid'))return false;
  const member=await c.query(`SELECT 1 FROM group_memberships WHERE chat_id=$1 AND user_id=$2 AND active AND (NOT $4 OR is_admin)
    AND last_seen_at>clock_timestamp()-$3::int*interval '1 millisecond'`,[chatId,actorId,product.membershipMaxAgeMs,manage]);
  return Boolean(member.rowCount);
}
const base={permission:'school.manage',risk:'write',modelCallable:true} as const;
export const automationTools:Tool[]=[
  schoolTool({...base,name:'school.config',risk:'read',permission:'school.write',description:'Ver configuración de Escuela y del resumen del grupo.',examples:['bot escuela configuración'],args:z.strictObject({}),async run(ctx){
    const r=(await ctx.c.query<{target_group_id:string;summary_schedule:SummarySchedule|null}>('SELECT target_group_id,summary_schedule FROM school_config WHERE chat_id=$1',[ctx.chat.id])).rows[0];
    const automation=(await ctx.c.query<{enabled:boolean;next_run_at:Date}>('SELECT enabled,next_run_at FROM automations WHERE chat_id=$1',[ctx.chat.id])).rows[0];
    return ok(`Zona: ${schoolZone}\nDestino: ${r?.target_group_id ?? ctx.chat.id}\nResumen: ${automation?.enabled && r?.summary_schedule?`${r.summary_schedule.days.map(d=>weekdays[d-1]).join(', ')} a las ${r.summary_schedule.time}; siguiente ${formatDue(automation.next_run_at,schoolZone)}`:'apagado'}`);
  }}),
  schoolTool({...base,name:'school.summary_configure',description:'Configurar resumen escolar por días (1=lunes a 7=domingo) y hora HH:mm en America/Mexico_City; puede apagarse. Solo owner/admin.',examples:['bot escuela resumen 07:00 lunes,martes,miércoles,jueves,viernes','bot escuela resumen off'],args:z.strictObject({enabled:z.boolean(),schedule:summarySchema.optional()}),async run(ctx,args){
    await lockSchool(ctx);
    const saved=(await ctx.c.query<{target_group_id:string;summary_schedule:unknown}>('SELECT target_group_id,summary_schedule FROM school_config WHERE chat_id=$1',[ctx.chat.id])).rows[0]!;
    const schedule=summarySchema.safeParse(args.schedule ?? saved.summary_schedule);
    if(args.enabled && !schedule.success)return fail('Indica los días y hora del resumen, por ejemplo «bot escuela resumen 07:00 lunes,martes,miércoles,jueves,viernes».');
    if(args.enabled && (!await schoolDestination(ctx.c,ctx.config,ctx.chat.id,ctx.actor.id) || !await schoolDestination(ctx.c,ctx.config,saved.target_group_id,ctx.actor.id)))return fail('El grupo de origen y el destino deben estar autorizados; las pruebas solo se entregan en Botsky Lab.');
    if(!args.enabled){await ctx.c.query('UPDATE automations SET enabled=false WHERE chat_id=$1',[ctx.chat.id]);return ok('Resumen escolar apagado.');}
    const parsed=schedule.data!;const next=nextSummary(parsed,ctx.now);
    await ctx.c.query('UPDATE school_config SET summary_schedule=$2 WHERE chat_id=$1',[ctx.chat.id,JSON.stringify(parsed)]);
    await ctx.c.query(`INSERT INTO automations(chat_id,kind,owner_id,enabled,config,next_run_at) VALUES($1,'school_summary',$2,true,$3,$4)
      ON CONFLICT(chat_id,kind) DO UPDATE SET owner_id=excluded.owner_id,enabled=true,config=excluded.config,next_run_at=excluded.next_run_at`,[ctx.chat.id,ctx.actor.id,JSON.stringify(parsed),next]);
    return ok(`Resumen escolar configurado: ${parsed.days.map(d=>weekdays[d-1]).join(', ')} a las ${parsed.time} (${schoolZone}). Siguiente: ${formatDue(next,schoolZone)}. Destino: ${saved.target_group_id}.`);
  }}),
  schoolTool({...base,name:'school.destination',modelCallable:false,description:'Elegir grupo de destino escolar habilitado, con permisos en ambos grupos. Barrera actual: solo Botsky Lab.',examples:['bot escuela destino aquí'],args:z.strictObject({targetGroupId:z.string().regex(/^\d+@g\.us$/).optional()}),async run(ctx,args){
    const target=args.targetGroupId ?? ctx.chat.id;
    if(!await schoolDestination(ctx.c,ctx.config,target,ctx.actor.id))return fail('Destino no autorizado. En esta fase las publicaciones solo pueden entregarse en Botsky Lab.');
    await lockSchool(ctx);
    await ctx.c.query('UPDATE school_config SET target_group_id=$2 WHERE chat_id=$1',[ctx.chat.id,target]);
    return ok(`Destino escolar configurado: ${target}.`);
  }}),
];
type Automation={id:string;chat_id:string;owner_id:string;config:unknown;next_run_at:Date;outbox_id:string|null;target_group_id:string};
export async function tickSchool(db:Db,config:Config):Promise<void>{
  await transaction(db,async c=>{
    const lock=await c.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext('botsky-school-tick')) AS locked");
    if(!lock.rows[0]?.locked)return;
    // Retention clears only expired school originals; metadata and tasks remain auditable.
    await c.query('UPDATE school_attachments SET data=NULL WHERE expires_at<=clock_timestamp() AND data IS NOT NULL');
    await c.query("UPDATE school_imports SET status='expired' WHERE status='preview' AND expires_at<=clock_timestamp()");
    const flags=(await c.query<{key:string;value:unknown}>('SELECT key,value FROM system_flags')).rows;
    if(flags.some(f=>f.key==='emergency' && f.value===true))return;
    const maintenance=flags.some(f=>f.key==='maintenance' && f.value===true);
    const rows=await c.query<Automation>(`SELECT a.*,s.target_group_id FROM automations a JOIN school_config s ON s.chat_id=a.chat_id
      WHERE a.enabled AND (a.next_run_at<=clock_timestamp() OR a.outbox_id IS NOT NULL) ORDER BY a.next_run_at LIMIT $1 FOR UPDATE OF a SKIP LOCKED`,[product.schoolAutomationBatch]);
    for(const a of rows.rows){
      const schedule=summarySchema.safeParse(a.config);
      if(!schedule.success){await c.query('UPDATE automations SET enabled=false WHERE id=$1',[a.id]);continue;}
      if(a.outbox_id){
        const delivered=(await c.query<{status:string;created_at:Date}>("SELECT status,created_at FROM outbox WHERE id=$1",[a.outbox_id])).rows[0];
        if(!delivered || !['sent','failed'].includes(delivered.status))continue;
        await c.query('UPDATE automations SET last_run_at=$2,next_run_at=$3,outbox_id=NULL WHERE id=$1',[a.id,delivered.created_at,nextSummary(schedule.data,new Date())]);
        // Uncertain delivery never gets another run. A definite failure is visible in error_log.
        continue;
      }
      if(maintenance && !config.OWNER_JIDS.includes(a.owner_id))continue;
      if(!await schoolDestination(c,config,a.chat_id,a.owner_id) || !await schoolDestination(c,config,a.target_group_id,a.owner_id))continue;
      const local=DateTime.now().setZone(schoolZone);
      const lessons=await c.query<{name:string;start:string;end:string}>(`SELECT s.name,to_char(h.start_time,'HH24:MI') AS start,to_char(h.end_time,'HH24:MI') AS end FROM school_schedule h
        JOIN school_subjects s ON s.id=h.subject_id AND s.chat_id=h.chat_id WHERE h.chat_id=$1 AND h.weekday=$2 ORDER BY h.start_time`,[a.chat_id,local.weekday]);
      const tasks=await c.query<{id:string;name:string;title:string;due_at:Date|null}>(`SELECT t.id,s.name,t.title,t.due_at FROM school_tasks t JOIN school_subjects s ON s.id=t.subject_id AND s.chat_id=t.chat_id
        WHERE t.chat_id=$1 AND t.deleted_at IS NULL ORDER BY t.due_at NULLS LAST,t.id LIMIT $2`,[a.chat_id,product.schoolResults]);
      const late=Date.now()-a.next_run_at.getTime()>product.tickMs*2;
      const text=`Resumen escolar · ${local.toISODate()} (${schoolZone})\nProgramado: ${formatDue(a.next_run_at,schoolZone)}${late?'\nVa con retraso por una interrupción; se omiten repeticiones atrasadas.':''}\nClases de hoy:\n${lessons.rows.map(l=>`${l.start}–${l.end}: ${l.name}`).join('\n') || 'Sin clases registradas.'}\nTareas (hasta ${product.schoolResults}, incluidas vencidas):\n${tasks.rows.map(t=>`#${t.id} [${t.name}] ${t.title} · ${t.due_at?formatDue(t.due_at,schoolZone):'sin fecha de entrega'}`).join('\n') || 'Sin tareas.'}`;
      const out=await c.query<{id:string}>(`INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,'school_summary',$2,$3)
        ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,[a.target_group_id,JSON.stringify({text,sourceId:'',automationId:a.id}),`school-summary:${a.id}:${a.next_run_at.toISOString()}`]);
      await c.query('UPDATE automations SET outbox_id=$2 WHERE id=$1',[a.id,out.rows[0]!.id]);
    }
  });
}
