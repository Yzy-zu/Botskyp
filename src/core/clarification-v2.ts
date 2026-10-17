import { DateTime } from 'luxon';
import { semanticTimeSchema } from '../modules/reminders/semantic-time.js';
import { openClarificationV2 } from './sessions-v2.js';
import type { ExecutionContextV2 } from './policy-v2/types.js';

/** Freeze the calendar day on the initial turn; only AM/PM remains a slot. */
export async function openTimeClarificationV2(ctx: ExecutionContextV2, name: string, args: unknown, code: string): Promise<void> {
  if(!name.startsWith('reminders.') || !/AMBIGUOUS_HOUR/u.test(code) || !args || typeof args!=='object')return;
  const input=args as Record<string,unknown>, time=semanticTimeSchema.safeParse(input.time);
  if(!time.success || time.data.kind==='relative' || time.data.meridiem)return;
  const value=time.data, base=DateTime.fromJSDate(ctx.now,{zone:'America/Mexico_City'});
  const date=value.kind==='date'?value.date:value.kind==='weekday'?base.plus({days:(value.weekday-base.weekday+7)%7 || 7}).toISODate():base.plus({days:value.kind==='tomorrow'?1:value.kind==='day_after_tomorrow'?2:0}).toISODate();
  await openClarificationV2(ctx.legacy.c,ctx.legacy.config.ROUTER_MODE,{
    actorId:ctx.actorId,chatId:ctx.chatId,pendingTool:name,partialArgs:{...input,time:{kind:'date',date,hour:value.hour,minute:value.minute}},
    missingSlots:[{kind:'am_pm',hour:value.hour}],prompt:`¿A las ${value.hour} de la mañana o de la noche?`,code,now:ctx.now,
  });
}
