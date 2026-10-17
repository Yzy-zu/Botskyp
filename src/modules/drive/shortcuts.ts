import type { Shortcut } from '../../core/shortcuts.js';
export function driveShortcut(text:string):Shortcut|undefined{
  let m:RegExpExecArray|null;
  if((m=/^drive cancelar\s+(\S+)$/iu.exec(text)))return {name:'drive.cancel',args:{id:m[1]}};
  if((m=/^drive buscar\s+([\s\S]+)$/iu.exec(text)))return {name:'drive.search',args:{query:m[1]}};
  if((m=/^drive (descargar|info)\s+(\S+)$/iu.exec(text)))return {name:m[1]!.toLowerCase()==='info'?'drive.info':'drive.download',args:{id:m[2]}};
  if(/^drive subir$/iu.test(text))return {name:'drive.upload',args:{}};
  if(/^drive(?: trabajos| estado)?$/iu.test(text))return {name:'drive.status',args:{}};
  if((m=/^drive configurar (on|off)$/iu.exec(text)))return {name:'drive.configure',args:{enabled:m[1]!.toLowerCase()==='on'}};
  if(/^drive(?:\s|$)/iu.test(text))return {name:'drive.info',args:{id:'invalid-command'}};
  return undefined;
}
