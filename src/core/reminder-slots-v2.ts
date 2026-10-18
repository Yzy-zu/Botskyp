import { DateTime } from 'luxon';
import { explicitClock, semanticTimeSchema } from '../modules/reminders/semantic-time.js';
import { sessionTextV2 } from './session-input-v2.js';
import type { SessionV2 } from './sessions-v2.js';

export function mergeSessionSlotsV2(args: Record<string, unknown>, slots: Record<string, unknown>): Record<string, unknown> {
  const time=args.time;
  if(time && typeof time==='object' && 'period' in slots)return {...args,time:{...time,meridiem:slots.period}};
  return {...args,...slots};
}
/** Accept only complete temporal fragments; unrelated intents always escape. */
export function reminderSlotUpdateV2(session: SessionV2, text: string, now: Date): {args: Record<string,unknown>; ready: boolean; missingSlots:SessionV2['missing_slots']} | undefined {
  if(!session.pending_tool.startsWith('reminders.'))return;
  const original=semanticTimeSchema.safeParse(session.partial_args.time);
  if(!original.success || original.data.kind==='relative')return;
  const value=sessionTextV2(text).replace(/^si\s*[,;]?\s*pero\s+/u,'').replace(/^mejor\s+/u,'');
  const weekdays=['lunes','martes','miercoles','jueves','viernes','sabado','domingo'];
  const date=/^(hoy|manana|pasado manana|(?:el )?(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))(?:\s+|$)/u.exec(value);
  let remainder=date?value.slice(date[0].length).trim():value;
  remainder=remainder.replace(/^a las?\s+/u,'');
  let clock=explicitClock(remainder);
  if(/^(?:[ap]\.?\s*m\.?|(?:de|por|en) la (?:manana|noche|tarde))$/u.test(remainder))clock=explicitClock(`${original.data.hour} ${remainder}`);
  if(!clock && /^\d{1,2}$/u.test(remainder) && Number(remainder)<=23)clock={hour:Number(remainder),minute:0};
  if(remainder && !/^(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.?\s*m\.?|(?:de|por|en) la (?:manana|noche|tarde))?|\d{1,2}:\d{2}|[ap]\.?\s*m\.?|(?:de|por|en) la (?:manana|noche|tarde))$/u.test(remainder))return;
  if(!date && !clock)return;
  const time={...original.data,...clock};
  const missingSlots:SessionV2['missing_slots']=[];
  if(!date && session.missing_slots.some(s=>s.kind==='choice' && s.field==='date'))missingSlots.push({kind:'choice',field:'date',choices:['hoy','mañana']});
  if(!time.meridiem && time.hour>=1 && time.hour<=12)missingSlots.push({kind:'am_pm',hour:time.hour});
  if(date){
    const label=date[1]!.replace(/^el /u,''),base=DateTime.fromJSDate(now,{zone:'America/Mexico_City'});
    const day=label==='hoy'?base:label==='manana'?base.plus({days:1}):label==='pasado manana'?base.plus({days:2}):base.plus({days:(weekdays.indexOf(label)+1-base.weekday+7)%7 || 7});
    const updated={kind:'date' as const,date:day.toISODate()!,hour:time.hour,minute:time.minute,...(time.meridiem?{meridiem:time.meridiem}:{})};
    return {args:{time:updated},ready:!missingSlots.length,missingSlots};
  }
  return {args:{time},ready:!missingSlots.length,missingSlots};
}
