import { DateTime } from 'luxon';
import { semanticTimeSchema, explicitClock } from '../modules/reminders/semantic-time.js';
import { openClarificationV2 } from './sessions-v2.js';
import { ambiguousTime } from '../modules/reminders/time.js';
import type { ExecutionContextV2 } from './policy-v2/types.js';

/** Freeze known calendar data and retain the explicit clock across follow-ups. */
export async function openTimeClarificationV2(ctx: ExecutionContextV2, name: string, args: unknown, code: string): Promise<void> {
  if(!name.startsWith('reminders.') || !/^(?:AMBIGUOUS_HOUR|MISSING_DATE)$/u.test(code) || !args || typeof args!=='object')return;
  const input=args as Record<string,unknown>, time=semanticTimeSchema.safeParse(input.time);
  if(!time.success || time.data.kind==='relative')return;
  const value={...time.data,...explicitClock(ctx.legacy.msg.text)}, base=DateTime.fromJSDate(ctx.now,{zone:'America/Mexico_City'});
  if(code==='AMBIGUOUS_HOUR' && ambiguousTime(ctx.legacy.msg.text))delete value.meridiem;
  if(code==='AMBIGUOUS_HOUR' && value.meridiem && !ambiguousTime(ctx.legacy.msg.text))return;
  const date=value.kind==='date'?value.date:value.kind==='weekday'?base.plus({days:(value.weekday-base.weekday+7)%7 || 7}).toISODate():base.plus({days:value.kind==='tomorrow'?1:value.kind==='day_after_tomorrow'?2:0}).toISODate();
  await openClarificationV2(ctx.legacy.c,ctx.legacy.config.ROUTER_MODE,{
    actorId:ctx.actorId,chatId:ctx.chatId,pendingTool:name,partialArgs:{...input,time:{kind:'date',date,hour:value.hour,minute:value.minute,...(value.meridiem?{meridiem:value.meridiem}:{})}},
    missingSlots:code==='MISSING_DATE'?[{kind:'choice',field:'date',choices:['hoy','mañana']}]:[{kind:'am_pm',hour:value.hour}],prompt:code==='MISSING_DATE'?'¿Para hoy o mañana?':`¿A las ${value.hour} de la mañana o de la noche?`,code,now:ctx.now,
  });
}
