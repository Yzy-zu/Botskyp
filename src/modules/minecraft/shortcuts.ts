import type { Shortcut } from '../../core/shortcuts.js';
export function minecraftShortcut(text:string):Shortcut|undefined{
  const match=/^(?:mc|minecraft)(?:\s+(.*))?$/iu.exec(text);
  if(!match)return undefined;
  const t=(match[1] ?? 'status').trim();
  const aliases:Record<string,string>={estado:'status',jugadores:'players',iniciar:'start',detener:'stop',reiniciar:'restart',respaldo:'backup',recursos:'resources',mundos:'worlds',config:'config-get',operaciones:'operations'};
  if(/^(?:\S+)$/u.test(t))return {name:`minecraft.${aliases[t.toLowerCase()] ?? t.toLowerCase()}`,args:{}};
  let m:RegExpExecArray|null;
  if((m=/^logs (\d+)$/u.exec(t)))return {name:'minecraft.logs',args:{lines:Number(m[1])}};
  if((m=/^(?:console|consola) (.+)$/u.exec(t)))return {name:'minecraft.console',args:{command:m[1]}};
  if((m=/^config-set (\S+) (\S+)$/u.exec(t)))return {name:'minecraft.config-set',args:{key:m[1],value:m[2]}};
  // Invalid Minecraft syntax is rejected locally and never passed to Gemini.
  return {name:'minecraft.invalid',args:{}};
}
