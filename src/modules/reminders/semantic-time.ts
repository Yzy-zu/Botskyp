import { DateTime } from 'luxon';
import { z } from 'zod';

export const semanticTimezone = 'America/Mexico_City';
const clock = {
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59).default(0),
  meridiem: z.enum(['am', 'pm', 'morning', 'afternoon', 'night', '24h']).optional(),
};
export const semanticTimeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('relative'), amount: z.number().int().positive().max(525600), unit: z.enum(['minute', 'hour', 'day']) }),
  z.strictObject({ kind: z.enum(['today', 'tomorrow', 'day_after_tomorrow']), ...clock }),
  z.strictObject({ kind: z.literal('weekday'), weekday: z.number().int().min(1).max(7), ...clock }),
  z.strictObject({ kind: z.literal('date'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...clock }),
]);
export type SemanticTimeInput = z.input<typeof semanticTimeSchema>;
export type ExplicitClock = { hour: number; minute: number; meridiem?: 'am' | 'pm' | '24h' };
/** Small clock grammar for authenticated text, never a general intent router. */
export function explicitClock(text: string): ExplicitClock | undefined {
  const match = /(?<![\p{L}\d])(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?|(?:de|por|en) la (ma[ñn]ana|noche|tarde))(?![\p{L}])/iu.exec(text);
  if(match){
    const hour=Number(match[1]), minute=Number(match[2] ?? 0);
    if(hour>23 || minute>59)return;
    return {hour,minute,meridiem:match[3]?.toLowerCase()==='a' || /^ma[ñn]ana$/iu.test(match[4] ?? '')?'am':'pm'};
  }
  const clock=/(?<![\p{L}\d])(\d{1,2}):(\d{2})(?!\d)/u.exec(text);
  if(clock && Number(clock[1])<=23 && Number(clock[2])<=59)return {hour:Number(clock[1]),minute:Number(clock[2]),meridiem:'24h'};
  return;
}
export type SemanticTimeResolution = { status: 'ok'; dueAt: Date; timezone: typeof semanticTimezone }
  | { status: 'needs_clarification'; code: 'ambiguous_hour' }
  | { status: 'error'; code: 'invalid_time' | 'past_time' };

/** Structured semantics only; the backend owns the clock and timezone. No production router integration. */
export function resolveSemanticTime(input: SemanticTimeInput, now: Date): SemanticTimeResolution {
  const parsed = semanticTimeSchema.safeParse(input);
  const base = DateTime.fromJSDate(now, { zone: semanticTimezone });
  if (!parsed.success || !base.isValid) return { status: 'error', code: 'invalid_time' };
  const value = parsed.data;
  let due: DateTime;
  if (value.kind === 'relative') {
    due = base.plus({ [value.unit]: value.amount });
  } else {
    let hour = value.hour;
    if (!value.meridiem && hour >= 1 && hour <= 12) return { status: 'needs_clarification', code: 'ambiguous_hour' };
    if (value.meridiem && value.meridiem !== '24h') {
      const pm = ['pm', 'afternoon', 'night'].includes(value.meridiem);
      if ((hour === 0 && !['am', 'night'].includes(value.meridiem)) || (hour > 12 && !pm)) return { status: 'error', code: 'invalid_time' };
      if (hour >= 1 && hour <= 12) hour = hour % 12 + (pm ? 12 : 0);
    }
    let day: DateTime = base.startOf('day');
    if (value.kind === 'tomorrow') day = day.plus({ days: 1 });
    if (value.kind === 'day_after_tomorrow') day = day.plus({ days: 2 });
    // "Próximo viernes" always means the strictly following weekday, including next week on Friday.
    if (value.kind === 'weekday') day = day.plus({ days: (value.weekday - base.weekday + 7) % 7 || 7 });
    if (value.kind === 'date') day = DateTime.fromISO(value.date, { zone: semanticTimezone });
    due = day.set({ hour, minute: value.minute, second: 0, millisecond: 0 });
    if (due.hour !== hour || due.minute !== value.minute) return { status: 'error', code: 'invalid_time' };
  }
  if (!due.isValid) return { status: 'error', code: 'invalid_time' };
  if (due.toMillis() <= base.toMillis()) return { status: 'error', code: 'past_time' };
  return { status: 'ok', dueAt: due.toJSDate(), timezone: semanticTimezone };
}
export function formatHumanDue(date: Date): string {
  const local = DateTime.fromJSDate(date, { zone: semanticTimezone }).setLocale('es-MX');
  if (!local.isValid) throw new Error('Invalid due date');
  return `${local.toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm")} (hora de Ciudad de México)`;
}
