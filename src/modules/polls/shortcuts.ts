import type { Shortcut } from '../../core/shortcuts.js';
export function pollShortcut(text:string):Shortcut|undefined{
  let m:RegExpExecArray|null;
  if((m=/^cerrar encuesta\s+#?(\d+)$/iu.exec(text)))return {name:'polls.close',args:{id:m[1]}};
  if((m=/^votar\s+#?(\d+)\s+(\d+)$/iu.exec(text)))return {name:'polls.vote',args:{id:m[1],option:Number(m[2])}};
  if((m=/^encuesta\s+#?(\d+)$/iu.exec(text)))return {name:'polls.results',args:{id:m[1]}};
  if((m=/^encuesta\s+(?:(\d+)m\s+)?(.+)$/isu.exec(text))){
    const parts=m[2]!.split('|').map(p=>p.trim());
    return {name:'polls.create',args:{question:parts[0],options:parts.slice(1),...(m[1]?{minutes:Number(m[1])}:{})}};
  }
  return undefined;
}
