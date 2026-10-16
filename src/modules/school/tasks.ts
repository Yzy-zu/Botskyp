import { z } from 'zod';
import { product } from '../../../config/product.js';
import { schoolTool,schoolAccess } from './access.js';
import { ok,fail,type Tool,type ToolCtx } from '../../core/tools.js';
import { subjectName,schoolId,nextClass,explicitDue,schoolZone,type Lesson } from './schemas.js';
import { formatDue } from '../reminders/time.js';
import { attachmentSource,captureAttachment } from './attachments.js';
import { lockSchool } from './schedule.js';
const base={permission:'school.write',risk:'read',modelCallable:true} as const;
const title=z.string().trim().min(1).max(product.schoolTaskChars);
export type TaskRow={id:string;title:string;subject:string;due_at:Date|null;due_source:string|null;created_by:string;attachment_ids:string[];deleted_at:Date|null};
export function taskText(task:TaskRow):string{
  return `#${task.id} [${task.subject}] ${task.title}\nEntrega: ${task.due_at?formatDue(task.due_at,schoolZone):'sin fecha de entrega'}${task.due_source==='next_class'?' (próxima clase)':''}\nAutor: ${task.created_by}${task.attachment_ids.length?`\nAdjuntos: ${task.attachment_ids.length}; bot tarea adjunto ${task.id}`:''}`;
}
export async function tasksFor(ctx:ToolCtx,subject?:string):Promise<TaskRow[]>{
  return (await ctx.c.query<TaskRow>(`SELECT t.*,s.name AS subject FROM school_tasks t JOIN school_subjects s ON s.id=t.subject_id AND s.chat_id=t.chat_id
    WHERE t.chat_id=$1 AND t.deleted_at IS NULL AND ($2::text IS NULL OR lower(s.name)=lower($2)) ORDER BY t.due_at NULLS LAST,t.id LIMIT $3`,[ctx.chat.id,subject ?? null,product.schoolResults])).rows;
}
export const taskTools:Tool[]=[
  schoolTool({...base,name:'school.tasks',description:'Listar tareas escolares vigentes del chat, incluidas vencidas y sin fecha; opcionalmente por materia.',examples:['bot tareas','bot tareas de Matemáticas'],args:z.strictObject({subject:subjectName.optional()}),async run(ctx,args){
    const rows=await tasksFor(ctx,args.subject);return ok(rows.map(taskText).join('\n\n') || 'No hay tareas para esa consulta.');
  }}),
  schoolTool({...base,name:'school.task_create',risk:'write',description:'Registrar UNA tarea atribuida al miembro autenticado. subject debe ser una materia existente. dueAt solo si el usuario dio fecha explícita ISO con zona; omitirlo usa próxima clase o sin fecha. includeAttachment usa el archivo actual/citado/propio reciente sin IDs del modelo.',examples:['bot tarea Matemáticas | ejercicios 1 al 5','bot tarea Matemáticas | proyecto | 2026-11-10T08:00:00-06:00'],args:z.strictObject({subject:subjectName,title,dueAt:z.string().optional(),includeAttachment:z.boolean().optional()}),async run(ctx,args){
    await lockSchool(ctx);
    const previous=await ctx.c.query<TaskRow>(`SELECT t.*,s.name AS subject FROM school_tasks t JOIN school_subjects s ON s.id=t.subject_id WHERE t.chat_id=$1 AND t.created_by=$2 AND t.source_message_id=$3`,[ctx.chat.id,ctx.actor.id,ctx.msg.id]);
    if(previous.rows[0])return ok(`Esta solicitud ya registró la tarea #${previous.rows[0].id}.`);
    const subject=(await ctx.c.query<{id:string}>('SELECT id FROM school_subjects WHERE chat_id=$1 AND lower(name)=lower($2) AND active',[ctx.chat.id,args.subject])).rows[0];
    if(!subject)return fail('No encontré esa materia. Consulta «bot materias»; un administrador puede registrarla.');
    let due:Date|undefined;let dueSource:string|null=null;
    if(args.dueAt){due=explicitDue(args.dueAt,ctx.now);if(!due)return fail('La fecha debe ser futura e incluir hora y zona explícitas, por ejemplo 2026-11-10T08:00:00-06:00.');dueSource='explicit';}
    else{
      const lessons=(await ctx.c.query<Lesson>(`SELECT weekday,to_char(start_time,'HH24:MI') AS start,to_char(end_time,'HH24:MI') AS end FROM school_schedule WHERE chat_id=$1 AND subject_id=$2`,[ctx.chat.id,subject.id])).rows;
      due=nextClass(lessons,ctx.now);dueSource=due?'next_class':null;
    }
    const attachments:string[]=[];
    if(args.includeAttachment || (args.includeAttachment!==false && ctx.msg.attachments.length)){
      const source=await attachmentSource(ctx);
      if(!source?.attachments.length)return fail('No tengo ese adjunto en este chat. Adjunta una imagen o PDF, o cita el mensaje original.');
      if(source.attachments.length!==1 || !['image','document'].includes(source.attachments[0]!.kind))return fail('Adjunta una imagen o PDF por tarea; máximo 4 MB.');
      attachments.push((await captureAttachment(ctx,source)).id);
    }
    const row=await ctx.c.query<{id:string}>(`INSERT INTO school_tasks(chat_id,subject_id,title,due_at,due_source,created_by,source_message_id,attachment_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[ctx.chat.id,subject.id,args.title,due ?? null,dueSource,ctx.actor.id,ctx.msg.id,attachments]);
    const task=(await tasksFor(ctx,args.subject)).find(t=>t.id===row.rows[0]!.id);
    // The inserted row may be beyond the listing limit; render from validated input instead.
    return ok(`Registré la tarea:\n${taskText(task ?? {id:row.rows[0]!.id,title:args.title,subject:args.subject,due_at:due ?? null,due_source:dueSource,created_by:ctx.actor.id,attachment_ids:attachments,deleted_at:null})}`);
  }}),
  schoolTool({...base,name:'school.task_edit',risk:'write',description:'Editar título/fecha de una tarea propia. Owner/admin pueden editar cualquiera del grupo. dueAt=null quita la fecha; omitirlo conserva la existente.',examples:['bot tarea edita 1 | ejercicios 1 al 10','bot tarea fecha 1 | 2026-11-10T08:00:00-06:00','bot tarea fecha 1 | sin fecha'],args:z.strictObject({id:schoolId,title:title.optional(),dueAt:z.string().nullable().optional()}),async run(ctx,args){
    if(args.title===undefined && args.dueAt===undefined)return fail('Indica un título o fecha nuevos.');
    await lockSchool(ctx);
    const task=(await ctx.c.query<{created_by:string}>('SELECT created_by FROM school_tasks WHERE chat_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',[ctx.chat.id,args.id])).rows[0];
    if(!task)return fail('No encontré esa tarea en este chat.');
    if(task.created_by!==ctx.actor.id && !await schoolAccess(ctx,true))return fail('No.');
    const due=args.dueAt?explicitDue(args.dueAt,ctx.now):null;
    if(args.dueAt && !due)return fail('La fecha debe ser futura e incluir hora y zona explícitas.');
    await ctx.c.query(`UPDATE school_tasks SET title=coalesce($3,title),due_at=CASE WHEN $4 THEN $5 ELSE due_at END,
      due_source=CASE WHEN $4 THEN $6 ELSE due_source END,updated_at=now() WHERE chat_id=$1 AND id=$2`,[ctx.chat.id,args.id,args.title ?? null,args.dueAt!==undefined,due,args.dueAt?'explicit':null]);
    return ok(`Actualicé la tarea #${args.id}.`);
  }}),
  schoolTool({...base,name:'school.task_delete',permission:'school.manage',risk:'destructive',description:'Eliminar una tarea mediante borrado lógico y confirmación; solo owner/admin del grupo.',examples:['bot tarea borra 1'],args:z.strictObject({id:schoolId}),async run(ctx,args){
    const r=await ctx.c.query('UPDATE school_tasks SET deleted_at=now(),updated_at=now() WHERE chat_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id',[ctx.chat.id,args.id]);
    return r.rowCount?ok(`Eliminé la tarea #${args.id}.`):fail('No encontré esa tarea en este chat.');
  }}),
  schoolTool({...base,name:'school.task_attachment',description:'Solicitar el original adjunto de una tarea de este grupo; disponible siete días. Se entrega por outbox en este mismo chat.',examples:['bot tarea adjunto 1'],args:z.strictObject({id:schoolId}),async run(ctx,args){
    const r=await ctx.c.query<{id:string}>(`SELECT a.id FROM school_tasks t JOIN school_attachments a ON a.chat_id=t.chat_id AND a.id=ANY(t.attachment_ids)
      WHERE t.chat_id=$1 AND t.id=$2 AND t.deleted_at IS NULL AND a.data IS NOT NULL AND a.expires_at>clock_timestamp()`,[ctx.chat.id,args.id]);
    if(!r.rowCount)return fail('Esa tarea no tiene un adjunto disponible; los originales se conservan siete días.');
    for(const a of r.rows)await ctx.c.query(`INSERT INTO outbox(chat_id,kind,payload,dedupe_key) VALUES($1,'school_attachment',$2,$3) ON CONFLICT DO NOTHING`,[ctx.chat.id,JSON.stringify({text:`Adjunto de tarea #${args.id}`,sourceId:ctx.msg.id,attachmentId:a.id,actorId:ctx.actor.id}),`school-attachment:${ctx.chat.id}:${ctx.msg.id}:${a.id}`]);
    return ok(`La entrega del adjunto de la tarea #${args.id} quedó en cola en este chat.`);
  }}),
];
