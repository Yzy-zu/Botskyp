import { expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { resolveSemanticTime, formatHumanDue, type SemanticTimeInput } from '../src/modules/reminders/semantic-time.js';
const now = new Date('2026-10-17T18:00:00Z'); // Saturday noon in Mexico City.
function local(input: SemanticTimeInput, base = now): string {
  const result = resolveSemanticTime(input, base);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('Expected resolved date');
  expect(result.timezone).toBe('America/Mexico_City');
  return DateTime.fromJSDate(result.dueAt, { zone: result.timezone }).toFormat('yyyy-MM-dd HH:mm');
}
it('resolves en 20 minutos from the backend clock', () => expect(local({ kind: 'relative', amount: 20, unit: 'minute' })).toBe('2026-10-17 12:20'));
it('resolves mañana a las 8 pm and de la noche to 20:00, and accepts consistent 24h pm/night hours', () => {
  for (const meridiem of ['pm', 'night'] as const) {
    expect(local({ kind: 'tomorrow', hour: 8, meridiem })).toBe('2026-10-18 20:00');
    expect(local({ kind: 'tomorrow', hour: 21, meridiem })).toBe('2026-10-18 21:00');
  }
});
it('mañana a las 8 requires clarification; explicit 24h is accepted; clock-only requires missing_date', () => {
  expect(resolveSemanticTime({ kind: 'tomorrow', hour: 8 }, now)).toEqual({ status: 'needs_clarification', code: 'ambiguous_hour' });
  expect(resolveSemanticTime({ kind: 'clock', hour: 8, meridiem: 'pm' }, now)).toEqual({ status: 'needs_clarification', code: 'missing_date' });
  expect(resolveSemanticTime({ kind: 'clock', hour: 20 }, now)).toEqual({ status: 'needs_clarification', code: 'missing_date' });
  expect(resolveSemanticTime({ kind: 'clock', hour: 8 }, now)).toEqual({ status: 'needs_clarification', code: 'missing_date' });
  expect(local({ kind: 'tomorrow', hour: 8, meridiem: '24h' })).toBe('2026-10-18 08:00');
});
it('distinguishes 12 am and 12 pm', () => {
  expect(local({ kind: 'tomorrow', hour: 12, meridiem: 'am' })).toBe('2026-10-18 00:00');
  expect(local({ kind: 'tomorrow', hour: 12, meridiem: 'pm' })).toBe('2026-10-18 12:00');
});
it('rejects past explicit dates and today at an elapsed hour without rolling forward', () => {
  for (const input of [{ kind: 'date', date: '2026-10-16', hour: 20 }, { kind: 'today', hour: 8, meridiem: 'am' }, { kind: 'today', hour: 12, meridiem: 'pm' }] as const) {
    expect(resolveSemanticTime(input, now)).toEqual({ status: 'error', code: 'past_time' });
  }
});
it('resolves próximo viernes strictly to the next Friday, including on Friday itself', () => {
  expect(local({ kind: 'weekday', weekday: 5, hour: 20 })).toBe('2026-10-23 20:00');
  expect(local({ kind: 'weekday', weekday: 5, hour: 20 }, new Date('2026-10-23T18:00:00Z'))).toBe('2026-10-30 20:00');
});
it('handles day after tomorrow, relative calendar days and explicit local dates', () => {
  expect(local({ kind: 'day_after_tomorrow', hour: 9, meridiem: 'morning', minute: 30 })).toBe('2026-10-19 09:30');
  expect(local({ kind: 'date', date: '2026-11-01', hour: 14 })).toBe('2026-11-01 14:00');
  expect(local({ kind: 'relative', amount: 1, unit: 'day' })).toBe('2026-10-18 12:00');
  expect(local({ kind: 'relative', amount: 1, unit: 'hour' })).toBe('2026-10-17 13:00');
  expect(local({ kind: 'relative', amount: 15, unit: 'minute' })).toBe('2026-10-17 12:15');
  expect(local({ kind: 'relative', amount: 3, unit: 'day' })).toBe('2026-10-20 12:00');
});
it('handles relative date with explicit clock time (REM-004 fix)', () => {
  // "en dos días a las diez de la mañana" -> 2026-10-19 10:00
  expect(local({ kind: 'relative', amount: 2, unit: 'day', hour: 10, meridiem: 'am' })).toBe('2026-10-19 10:00');
  // "dentro de tres días a las 15:30"
  expect(local({ kind: 'relative', amount: 3, unit: 'day', hour: 15, minute: 30 })).toBe('2026-10-20 15:30');
  // "en 3 días a las 8" without meridiem -> ambiguous_hour
  expect(resolveSemanticTime({ kind: 'relative', amount: 3, unit: 'day', hour: 8 }, now)).toEqual({ status: 'needs_clarification', code: 'ambiguous_hour' });
});
it('gracefully handles kind aliases produced by LLM for relative days', () => {
  expect(local({ kind: 'day', amount: 3, unit: 'day' } as unknown as SemanticTimeInput)).toBe('2026-10-20 12:00');
  expect(resolveSemanticTime({ kind: 'in', amount: 3, unit: 'day' } as unknown as SemanticTimeInput, now).status).toBe('error');
  expect(resolveSemanticTime({ kind: 'amount', amount: 3, unit: 'day' } as unknown as SemanticTimeInput, now).status).toBe('error');
});
it('rejects malformed semantics and nonexistent dates', () => {
  for (const input of [{ kind: 'date', date: '2026-02-30', hour: 20 }, { kind: 'today', hour: 24 }, { kind: 'today', hour: 15, meridiem: 'am' }, { kind: 'relative', amount: -1, unit: 'minute' }, { kind: 'tomorrow', hour: 20, timezone: 'UTC' }]) {
    expect(resolveSemanticTime(input as SemanticTimeInput, now)).toEqual({ status: 'error', code: 'invalid_time' });
  }
});
it('renders a human local date without UTC ISO strings', () => {
  const text = formatHumanDue(new Date('2026-10-19T02:00:00Z'));
  expect(text).toContain('domingo 18 de octubre de 2026, 20:00');
  expect(text).toContain('Ciudad de México');
  expect(text).not.toMatch(/2026-10-19T|UTC|Z$/);
});

it('covers required relative amounts and Wednesday evening', () => {
  expect(local({kind:'relative',amount:5,unit:'minute'})).toBe('2026-10-17 12:05');
  expect(local({kind:'relative',amount:2,unit:'hour'})).toBe('2026-10-17 14:00');
  expect(local({kind:'weekday',weekday:3,hour:7,meridiem:'pm'})).toBe('2026-10-21 19:00');
});
it('rejects clock fields that would otherwise be silently ignored', () => {
  for (const input of [
    {kind:'relative',amount:2,unit:'hour',hour:10},
    {kind:'relative',amount:2,unit:'day',meridiem:'pm'},
    {kind:'relative',amount:2,unit:'minute',minute:30},
  ]) expect(resolveSemanticTime(input as SemanticTimeInput, now).status).toBe('error');
});

it.each([{kind:'tomorrow'},{kind:'day_after_tomorrow'},{kind:'date',date:'2026-10-25'}] as const)(
  'asks for a missing hour without inventing one: %j', time => {
    expect(resolveSemanticTime(time,now)).toEqual({status:'needs_clarification',code:'missing_hour'});
  });
