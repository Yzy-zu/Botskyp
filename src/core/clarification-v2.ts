import { DateTime } from 'luxon';
import { semanticTimeSchema } from '../modules/reminders/semantic-time.js';
import { openClarificationV2, type SessionV2 } from './sessions-v2.js';
import type { ExecutionContextV2 } from './policy-v2/types.js';

/** Freeze known calendar data and retain the structured clock across follow-ups. */
export async function openTimeClarificationV2(ctx: ExecutionContextV2, name: string, args: unknown, code: string): Promise<void> {
  if (!name.startsWith('reminders.') || !/^(?:AMBIGUOUS_HOUR|MISSING_DATE)$/u.test(code) || !args || typeof args !== 'object') return;
  const input = args as Record<string, unknown>, time = semanticTimeSchema.safeParse(input.time);
  if (!time.success || time.data.kind === 'relative') return;
  const value = time.data;
  if (value.hour === undefined) return;
  const base = DateTime.fromJSDate(ctx.now, { zone: 'America/Mexico_City' });
  let hour24 = value.hour;
  if (value.meridiem && value.meridiem !== '24h' && hour24 >= 1 && hour24 <= 12) {
    hour24 = hour24 % 12 + (['pm', 'afternoon', 'night'].includes(value.meridiem) ? 12 : 0);
  }
  const storedTime = value.kind === 'clock'
    ? { kind: 'clock' as const, hour: hour24, minute: value.minute, ...(value.meridiem ? { meridiem: value.meridiem } : {}) }
    : {
      kind: 'date' as const,
      date: value.kind === 'date' ? value.date : value.kind === 'weekday' ? base.plus({ days: (value.weekday - base.weekday + 7) % 7 || 7 }).toISODate()! : base.plus({ days: value.kind === 'tomorrow' ? 1 : value.kind === 'day_after_tomorrow' ? 2 : 0 }).toISODate()!,
      hour: hour24,
      minute: value.minute,
      ...(value.meridiem ? { meridiem: value.meridiem } : {}),
    };
  const missingSlots: SessionV2['missing_slots'] = [];
  if (code === 'MISSING_DATE') missingSlots.push({ kind: 'choice', field: 'date', choices: ['hoy', 'mañana'] });
  if (!value.meridiem && value.hour >= 1 && value.hour <= 12) missingSlots.push({ kind: 'am_pm', hour: value.hour });
  if (!missingSlots.length) return;
  await openClarificationV2(ctx.legacy.c, ctx.legacy.config.ROUTER_MODE, {
    actorId: ctx.actorId, chatId: ctx.chatId, pendingTool: name,
    partialArgs: { ...input, time: storedTime },
    missingSlots,
    prompt: code === 'MISSING_DATE' ? '¿Para hoy o mañana?' : `¿A las ${value.hour} de la mañana o de la noche?`,
    code, now: ctx.now,
  });
}
