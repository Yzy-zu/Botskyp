import type { Shortcut } from '../../core/shortcuts.js';
import { weekdays } from './schemas.js';
const fold=(s:string)=>s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
function day(value:string):number{return weekdays.findIndex(d=>fold(d)===fold(value.trim()))+1;}
export function schoolShortcut(text:string):Shortcut|undefined{
  let m:RegExpExecArray|null;
  if(/^(?:(?:guarda|importa|carga) (?:este |el )?horario(?: (?:de|desde) (?:esta |la )?(?:foto|imagen))?)[.!?]?$/iu.test(text))return {name:'school.schedule_import',args:{}};
  if(/^materias[.!?]?$/iu.test(text))return {name:'school.subjects',args:{}};
  if((m=/^horario(?:\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))?[.!?]?$/iu.exec(text)))return {name:'school.schedule',args:m[1]?{weekday:day(m[1])}:{}};
  if((m=/^materia (agrega|edita)\s+(?:(\d+)\s+)?(.+)$/iu.exec(text)))return {name:'school.subject_save',args:{...(m[1]!.toLowerCase()==='edita'?{id:m[2] ?? ''}:{}),name:m[3]}};
  if((m=/^materia desactiva\s+#?(\d+)$/iu.exec(text)))return {name:'school.subject_archive',args:{id:m[1]}};
  if(/^horario (?:importa|importar|carga)(?: (?:foto|imagen))?[.!?]?$/iu.test(text))return {name:'school.schedule_import',args:{}};
  if((m=/^horario propone\s+(.+)$/isu.exec(text))){
    try{return {name:'school.schedule_propose',args:JSON.parse(m[1]!) as Record<string,unknown>};}
    catch{return {name:'school.schedule_propose',args:{}};}
  }
  if((m=/^tareas(?: de\s+(.+))?[.!?]?$/iu.exec(text)))return {name:'school.tasks',args:m[1]?{subject:m[1]}:{}};
  if((m=/^tarea (borra|adjunto)\s+#?(\d+)$/iu.exec(text)))return {name:m[1]!.toLowerCase()==='borra'?'school.task_delete':'school.task_attachment',args:{id:m[2]}};
  if((m=/^tarea edita\s+#?(\d+)\s*\|\s*(.+)$/isu.exec(text)))return {name:'school.task_edit',args:{id:m[1],title:m[2]!.trim()}};
  if((m=/^tarea fecha\s+#?(\d+)\s*\|\s*(.+)$/iu.exec(text)))return {name:'school.task_edit',args:{id:m[1],dueAt:fold(m[2]!.trim())==='sin fecha'?null:m[2]!.trim()}};
  if((m=/^tarea\s+([^|]+)\|\s*([^|]+)(?:\|\s*(.+))?$/isu.exec(text)))return {name:'school.task_create',args:{subject:m[1]!.trim(),title:m[2]!.trim(),...(m[3]?{dueAt:m[3].trim()}:{})}};
  if(/^escuela configuraci[oó]n$/iu.test(text))return {name:'school.config',args:{}};
  if((m=/^escuela destino\s+(aqu[ií]|\d+@g\.us)$/iu.exec(text)))return {name:'school.destination',args:/^aqu/iu.test(m[1]!)?{}:{targetGroupId:m[1]}};
  if(/^escuela resumen off$/iu.test(text))return {name:'school.summary_configure',args:{enabled:false}};
  if((m=/^escuela resumen\s+(\S+)\s+(.+)$/iu.exec(text)))return {name:'school.summary_configure',args:{enabled:true,schedule:{time:m[1],days:m[2]!.split(',').map(day)}}};
  return undefined;
}
