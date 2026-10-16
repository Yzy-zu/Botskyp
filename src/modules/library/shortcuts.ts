import type { Shortcut } from '../../core/shortcuts.js';
import { weekdays } from '../school/schemas.js';
export function libraryShortcut(text:string):Shortcut|undefined{
  let m:RegExpExecArray|null;const t=text.trim();
  if(/^(biblioteca|categor[ií]as)$/iu.test(t))return {name:'library.categories',args:{}};
  if(/^biblioteca estado$/iu.test(t))return {name:'library.sync_status',args:{}};
  if((m=/^biblioteca actualizar (local|drive)$/iu.exec(t)))return {name:'library.sync',args:{source:m[1]!.toLowerCase()}};
  if((m=/^(?:compra(?:r)?\s+)?pack(?:\s+(.+))?$/iu.exec(t)))return {name:'packs.buy',args:m[1]?{category:m[1]}:{}};
  if(/^packs$/iu.test(t))return {name:'packs.orders',args:{}};
  if(/^cooperacha$/iu.test(t))return {name:'cooperacha.status',args:{}};
  if(/^cooperacha cancelar$/iu.test(t))return {name:'cooperacha.cancel',args:{}};
  if((m=/^cooperacha abrir(?:\s+(\d+))?(?:\s+(.+))?$/iu.exec(t)))return {name:'cooperacha.open',args:{...(m[1]?{goal:Number(m[1])}:{}),...(m[2]?{category:m[2]}:{})}};
  if((m=/^(?:aporto|cooperacha aportar)\s+(\d+)$/iu.exec(t)))return {name:'cooperacha.contribute',args:{amount:Number(m[1])}};
  if(/^lluvia off$/iu.test(t))return {name:'library.rain',args:{enabled:false}};
  if((m=/^lluvia\s+(\d{2}:\d{2})\s+(\S+)\s+(\d+)(?:\s+(.+))?$/iu.exec(t))){
    const days=m[2]!.toLowerCase().split(',').map(d=>/^\d$/.test(d)?Number(d):weekdays.indexOf(d)+1);
    return {name:'library.rain',args:{enabled:true,config:{schedule:{time:m[1],days},count:Number(m[3]),...(m[4]?{category:m[4]}:{})}}};
  }
  return undefined;
}
