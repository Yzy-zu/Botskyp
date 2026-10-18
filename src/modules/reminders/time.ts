import { DateTime } from 'luxon';
import { z } from 'zod';
import { product } from '../../../config/product.js';
export const recurrenceSchema=z.strictObject({
  kind:z.enum(['daily','weekly','monthly']),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),
  weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),day:z.number().int().min(1).max(31).optional(),
}).refine(r=>r.kind!=='weekly' || Boolean(r.weekdays?.length),'Weekly recurrence requires weekdays').refine(r=>r.kind!=='monthly' || r.day!==undefined,'Monthly recurrence requires day');
export type Recurrence=z.infer<typeof recurrenceSchema>;
export function validateDue(iso:string,zone:string,now:Date):Date|null{
  if(!/(Z|[+-]\d{2}:\d{2})$/.test(iso))return null;
  const date=DateTime.fromISO(iso,{setZone:true});
  const local=date.setZone(zone);
  if(!date.isValid || !local.isValid || date.toMillis()<=now.getTime() || date.offset!==local.offset)return null;
  return date.toJSDate();
}
/** Calendar recurrence skips missed runs and nonexistent monthly days; UTC never drifts the local hour. */
export function nextOccurrence(after:Date,zone:string,input:Recurrence):Date{
  const r=recurrenceSchema.parse(input);
  let cursor=DateTime.fromJSDate(after,{zone}).startOf('day');
  for(let i=0;i<product.recurrenceLookAheadDays;i++){
    const candidate=cursor.set({hour:r.hour,minute:r.minute,second:0,millisecond:0});
    const matches=r.kind==='daily' || (r.kind==='weekly' && r.weekdays!.includes(candidate.weekday)) || (r.kind==='monthly' && candidate.day===r.day);
    if(matches && candidate.hour===r.hour && candidate.minute===r.minute && candidate.toMillis()>after.getTime())return candidate.toJSDate();
    cursor=cursor.plus({days:1});
  }
  throw new Error('Cannot calculate recurrence');
}
export function recurrenceMatchesDue(date:Date,zone:string,r:Recurrence):boolean{
  const local=DateTime.fromJSDate(date,{zone});
  return local.hour===r.hour && local.minute===r.minute && (r.kind!=='weekly' || r.weekdays!.includes(local.weekday)) && (r.kind!=='monthly' || local.day===r.day);
}
export function formatDue(date:Date,zone:string):string{return `${DateTime.fromJSDate(date,{zone}).setLocale('es-MX').toFormat('yyyy-MM-dd HH:mm')} (${zone})`;}
export function ambiguousTime(text:string):boolean{
  const clock=/a las?\s+(ocho|\d{1,2})(?::\d{2})?/iu.exec(text);
  if(!clock)return false;
  const hour=clock[1]==='ocho'?8:Number(clock[1]);
  if(hour>12)return false;
  return !/(?:de la|de|por la)\s+(ma[ñn]ana|tarde|noche|madrugada)|(?<![\p{L}])[ap]\.?\s*m\.?/iu.test(text);
}
