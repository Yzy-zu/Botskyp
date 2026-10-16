import { minecraftShortcut } from '../modules/minecraft/shortcuts.js';
import { economyShortcut } from '../modules/games/shortcuts.js';
import { schoolShortcut } from '../modules/school/shortcuts.js';
import { DateTime } from 'luxon';
import { callWord } from './activation.js';
import { searchRequest } from './search-context.js';
export type Shortcut={name:string;args:Record<string,unknown>};
const aliases:Record<string,string>={economía:'xp',economia:'xp',juegos:'games',moderación:'moderation',moderacion:'moderation',notas:'notes',recordatorios:'reminders',memoria:'memory','conversación':'conversation',conversacion:'conversation',web:'web','visión':'vision',vision:'vision',escuela:'school',school:'school'};
export function commandText(text:string):string{return text.trim().replace(/^(?:@\d+\s*)+/u,'').replace(new RegExp(`^${callWord.source}[\\s,:;!]*`,'iu'),'').trim();}
export function parseDate(text:string,zone:string,now:Date):string|undefined{
  const input=text.trim();
  if(/^\d{4}-\d{2}-\d{2}T/.test(input))return input;
  const local=DateTime.fromJSDate(now,{zone});
  const relative=/^(?:en\s+)?(\d+)\s+(minutos?|horas?|d[ií]as?)$/iu.exec(input);
  if(relative)return local.plus({[relative[2]!.startsWith('minuto')?'minutes':relative[2]!.startsWith('hora')?'hours':'days']:Number(relative[1])}).toISO() ?? undefined;
  const tomorrow=/^(ma[ñn]ana|hoy)\s+a las?\s+(\d{1,2}|ocho)(?::(\d{2}))?(?:\s+(?:de la|de|por la)\s+(ma[ñn]ana|tarde|noche|madrugada)|\s*([ap])\.?\s*m\.?)?\.?$/iu.exec(input);
  if(tomorrow){
    let hour=tomorrow[2]==='ocho'?8:Number(tomorrow[2]);const minute=Number(tomorrow[3] ?? 0);
    const period=tomorrow[4] ?? tomorrow[5];if(hour>23 || minute>59 || (hour<=12 && !period))return undefined;
    if(period){if(hour>12 || hour===0)return undefined;if(/tarde|noche|p/i.test(period))hour=hour%12+12;else hour=hour%12;}
    return local.plus({days:tomorrow[1]!.toLowerCase()==='hoy'?0:1}).set({hour,minute,second:0,millisecond:0}).toISO() ?? undefined;
  }
  return undefined;
}
export function shortcut(text:string,zone:string,now:Date):Shortcut|undefined{
  const t=commandText(text);let m:RegExpExecArray|null;
  const mc=minecraftShortcut(t);if(mc)return mc;
  const economy=economyShortcut(t);if(economy)return economy;
  const school=schoolShortcut(t);if(school)return school;
  const direct:Record<string,string>={'ping':'core.ping','apagado de emergencia':'control.emergency','reactiva':'control.reactivate','mantenimiento on':'control.maintenance_on','mantenimiento off':'control.maintenance_off','módulos':'control.modules','modulos':'control.modules','diag cuota':'diag.cuota','diag.cuota':'diag.cuota','diag errores':'diag.errores','diag.errores':'diag.errores','qué sabes de mí':'memory.list','que sabes de mi':'memory.list','olvídalo todo':'memory.forget','olvidalo todo':'memory.forget','recordatorios':'reminders.list','notas':'notes.list'};
  const name=direct[t.toLowerCase().replace(/[.!?]$/,'')];if(name)return {name,args:name==='memory.forget'?{target:'todo'}:{}};
  if((m=/^ayuda(?:\s+(.*))?$/iu.exec(t)))return {name:'core.help',args:{topic:aliases[m[1]?.toLowerCase() ?? ''] ?? m[1] ?? ''}};
  if((m=/^(activa|desactiva)\s+(\S+)\s+aqu[ií]$/iu.exec(t)))return {name:'control.modules',args:{module:aliases[m[2]!.toLowerCase()] ?? m[2],enabled:m[1]!.toLowerCase()==='activa'}};
  if((m=/^(?:nota guarda|guarda(?: que)?)\s+(.+)$/isu.exec(t)))return {name:'notes.create',args:{body:m[1]}};
  if((m=/^notas busca\s+(.+)$/isu.exec(t)))return {name:'notes.list',args:{query:m[1]}};
  if((m=/^nota (edita|borra)\s+#?(\d+)(?:\s+(.+))?$/isu.exec(t)))return {name:m[1]!.toLowerCase()==='edita'?'notes.edit':'notes.delete',args:{id:m[2],...(m[3]?{body:m[3]}:{})}};
  if((m=/^(?:acu[eé]rdate de(?: que)?|recuerda que|memoriza)\s+(.+)$/isu.exec(t)))return {name:'memory.remember',args:{body:m[1]}};
  if((m=/^olvida\s+(.+)$/isu.exec(t)))return {name:'memory.forget',args:{target:m[1]}};
  const search=searchRequest(t);
  if(search && !search.contextual)return {name:'web.search',args:{query:search.query}};
  if((m=/^recordatorio cancela\s+#?(\d+)$/iu.exec(t)))return {name:'reminders.cancel',args:{id:m[1]}};
  if((m=/^recordatorio edita\s+#?(\d+)\s+(\S+)\s+(.+)$/isu.exec(t)))return {name:'reminders.edit',args:{id:m[1],dueAt:m[2],body:m[3],timezone:zone}};
  const missingBody=commandText(t.replace(new RegExp(`${callWord.source}[.!?\\s]*$`,'iu'),''));
  if((m=/^(?:(?:haz|crea|pon|programa)\s+(?:un\s+)?)?recordatorio\s+(?:para\s+)?(?:dentro de|en)\s+(\d+|un|uno|dos|tres|cuatro|cinco|diez)\s+(minutos?|horas?|d[ií]as?)[.!]?$/iu.exec(missingBody))){
    const words:Record<string,number>={un:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,diez:10};
    const quantity=words[m[1]!.toLowerCase()] ?? Number(m[1]);
    return {name:'reminders.create',args:{dueAt:parseDate(`${quantity} ${m[2]!.toLowerCase()}`,zone,now),timezone:zone}};
  }
  if((m=/^recordatorio en\s+(\d+\s+(?:minutos?|horas?|d[ií]as?))\s+(.+)$/isu.exec(t)))return {name:'reminders.create',args:{body:m[2],dueAt:parseDate(m[1]!,zone,now),timezone:zone}};
  if((m=/^recu[eé]rdame\s+(.+)$/isu.exec(t))){
    const scheduled=/^(.+?)\s+((?:ma[ñn]ana|hoy)\s+a las?\s+.+|en\s+\d+\s+(?:minutos?|horas?|d[ií]as?))$/isu.exec(m[1]!);
    if(scheduled){const dueAt=parseDate(scheduled[2]!,zone,now);return {name:'reminders.create',args:{body:scheduled[1],timezone:zone,...(dueAt?{dueAt}:{})}};}
    // Complex dated/recurring requests are interpreted by the LLM rather than treated as missing a date.
    if(/\b(?:cada|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|a las|\d{4}-\d{2}-\d{2})\b/iu.test(m[1]!))return undefined;
    return {name:'reminders.create',args:{body:m[1],timezone:zone}};
  }
  return undefined;
}
