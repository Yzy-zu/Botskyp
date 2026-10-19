import { DateTime } from 'luxon';
import { z } from 'zod';

export const semanticTimezone = 'America/Mexico_City';
const clock = {
  hour: z.number().int().min(0).max(23).describe('Hora 0-23 (o 1-12 con meridiem)'),
  minute: z.number().int().min(0).max(59).default(0).describe('Minuto 0-59 (default 0)'),
  meridiem: z.enum(['am', 'pm', 'morning', 'afternoon', 'night', '24h']).optional().describe('am, pm, o franja horaria si se indicó'),
};
const relativeTime = z.strictObject({
  kind: z.literal('relative').describe('Tiempo relativo: "en N minutos", "en N horas", "en N días", "dentro de N días". OBLIGATORIO kind="relative".'),
  amount: z.number().int().positive().max(525600).describe('Cantidad entera de tiempo: 3 para "dentro de 3 días", 15 para "en 15 minutos"'),
  unit: z.enum(['minute', 'hour', 'day']).describe('Unidad: minute, hour, day'),
  hour: z.number().int().min(0).max(23).optional().describe('Hora específica si se indicó junto con la fecha relativa (ej. "en 2 días a las 10 am")'),
  minute: z.number().int().min(0).max(59).optional().default(0).describe('Minuto específico (0-59, default 0)'),
  meridiem: z.enum(['am', 'pm', 'morning', 'afternoon', 'night', '24h']).optional().describe('am, pm o franja horaria si se indicó'),
});
export const semanticTimeSchema = z.union([
  relativeTime,
  z.strictObject({ kind: z.enum(['today', 'tomorrow', 'day_after_tomorrow', 'clock']), ...clock }),
  z.strictObject({ kind: z.literal('weekday'), weekday: z.number().int().min(1).max(7).describe('Día de la semana: 1=lunes, 7=domingo'), ...clock }),
  z.strictObject({ kind: z.literal('date'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha ISO YYYY-MM-DD'), ...clock }),
]);
export type SemanticTimeInput = z.input<typeof semanticTimeSchema>;
export type SemanticTimeResolution = { status: 'ok'; dueAt: Date; timezone: typeof semanticTimezone }
  | { status: 'needs_clarification'; code: 'ambiguous_hour' | 'missing_date' }
  | { status: 'error'; code: 'invalid_time' | 'past_time' };

function normalizeSemanticInput(input: unknown): unknown {
  if (input && typeof input === 'object' && 'kind' in input) {
    const raw = input as Record<string, unknown>;
    if (raw.kind === 'day' || raw.kind === 'in' || raw.kind === 'amount') {
      return {
        ...raw,
        kind: 'relative',
        unit: raw.unit ?? 'day',
      };
    }
  }
  return input;
}

/** Structured semantics only; the backend owns the clock and timezone. No raw text parsing. */
export function resolveSemanticTime(input: SemanticTimeInput, now: Date): SemanticTimeResolution {
  const normalized = normalizeSemanticInput(input);
  const parsed = semanticTimeSchema.safeParse(normalized);
  const base = DateTime.fromJSDate(now, { zone: semanticTimezone });
  if (!parsed.success || !base.isValid) return { status: 'error', code: 'invalid_time' };
  const value = parsed.data;
  let due: DateTime;
  if (value.kind === 'relative') {
    if (value.unit === 'day' && value.hour !== undefined) {
      let hour = value.hour;
      if (value.meridiem && value.meridiem !== '24h') {
        const pm = ['pm', 'afternoon', 'night'].includes(value.meridiem);
        if ((hour === 0 && !['am', 'night'].includes(value.meridiem)) || (hour > 12 && !pm)) return { status: 'error', code: 'invalid_time' };
        if (hour >= 1 && hour <= 12) hour = hour % 12 + (pm ? 12 : 0);
      }
      if (!value.meridiem && value.hour >= 1 && value.hour <= 12) return { status: 'needs_clarification', code: 'ambiguous_hour' };
      const day = base.startOf('day').plus({ days: value.amount });
      due = day.set({ hour, minute: value.minute ?? 0, second: 0, millisecond: 0 });
      if (due.hour !== hour || due.minute !== (value.minute ?? 0)) return { status: 'error', code: 'invalid_time' };
    } else {
      due = base.plus({ [value.unit]: value.amount });
    }
  } else {
    let hour = value.hour;
    if (value.meridiem && value.meridiem !== '24h') {
      const pm = ['pm', 'afternoon', 'night'].includes(value.meridiem);
      if ((hour === 0 && !['am', 'night'].includes(value.meridiem)) || (hour > 12 && !pm)) return { status: 'error', code: 'invalid_time' };
      if (hour >= 1 && hour <= 12) hour = hour % 12 + (pm ? 12 : 0);
    }
    if (value.kind === 'clock') return { status: 'needs_clarification', code: 'missing_date' };
    if (!value.meridiem && value.hour >= 1 && value.hour <= 12) return { status: 'needs_clarification', code: 'ambiguous_hour' };
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
