import type { Shortcut } from '../../core/shortcuts.js';
export function messagingShortcut(text:string):Shortcut|undefined{
  let m:RegExpExecArray|null;
  if(/^destinos$/iu.test(text))return {name:'messaging.destinations',args:{}};
  if(/^operaciones$/iu.test(text))return {name:'bulk.status',args:{}};
  if((m=/^(enviar|difundir)\s+(\S+)\s*\|\s*([\s\S]+)$/iu.exec(text)))return {name:m[1]!.toLowerCase()==='enviar'?'messaging.send':'bulk.broadcast',args:{destinations:m[2]!.split(','),text:m[3]}};
  if((m=/^nuclear(?:\s+(\d+))?\s*\|\s*([\s\S]+)$/iu.exec(text)))return {name:'bulk.nuclear',args:{...(m[1]?{count:Number(m[1])}:{}),text:m[2]}};
  if((m=/^operaci[oó]n\s+(cancelar|continuar)\s+(\S+)$/iu.exec(text)))return {name:m[1]!.toLowerCase()==='cancelar'?'bulk.cancel':'bulk.resume',args:{id:m[2]}};
  if((m=/^reintentar fallidos\s+(\S+)$/iu.exec(text)))return {name:'bulk.retry',args:{id:m[1]}};
  if((m=/^operaci[oó]n\s+(\S+)$/iu.exec(text)))return {name:'bulk.status',args:{id:m[1]}};
  // Catch malformed sensitive commands deterministically, without offering them to a model.
  if(/^(nuclear|difundir|enviar|reintentar fallidos|operaci[oó]n)(?:\s|$)/iu.test(text))return {name:'bulk.status',args:{id:'invalid-command'}};
  return undefined;
}
