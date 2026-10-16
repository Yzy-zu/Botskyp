import { it,expect } from 'vitest';
import { DateTime } from 'luxon';
import { validateDue,nextOccurrence,ambiguousTime,recurrenceSchema } from '../src/modules/reminders/time.js';
import { parseDate } from '../src/core/shortcuts.js';
const zone='America/Mexico_City';
const now=new Date('2026-10-16T12:00:00Z');
it('validates future ISO offsets against the IANA zone and rejects missing or wrong offsets',()=>{
  expect(validateDue('2026-10-17T08:00:00-06:00',zone,now)?.toISOString()).toBe('2026-10-17T14:00:00.000Z');
  for(const iso of ['2026-10-15T08:00:00-06:00','2026-10-17T08:00:00','2026-10-17T08:00:00-05:00','garbage'])expect(validateDue(iso,zone,now)).toBeNull();
  expect(validateDue('2026-10-17T08:00:00-06:00','Invalid/zone',now)).toBeNull();
});
it('eight requires a period even if mañana already names the day',()=>{
  expect(ambiguousTime('mañana a las ocho')).toBe(true);expect(ambiguousTime('mañana a las 8')).toBe(true);
  expect(parseDate('mañana a las ocho',zone,now)).toBeUndefined();
  expect(ambiguousTime('mañana a las 8 de la mañana')).toBe(false);expect(ambiguousTime('hoy a las 20:00')).toBe(false);
  expect(parseDate('mañana a las ocho de la noche',zone,now)).toContain('20:00:00');
});
it('daily and weekly schedules keep local hour through a DST transition',()=>{
  const after=new Date('2026-03-07T14:00:00Z');
  const next=nextOccurrence(after,'America/New_York',{kind:'daily',hour:9,minute:0});
  expect(next.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  const weekly=nextOccurrence(after,'America/New_York',{kind:'weekly',hour:9,minute:0,weekdays:[7]});expect(weekly).toEqual(next);
});
it('monthly day 31 skips nonexistent days and catch-up advances from current time',()=>{
  const next=nextOccurrence(new Date('2026-04-01T00:00:00Z'),zone,{kind:'monthly',hour:8,minute:0,day:31});
  expect(DateTime.fromJSDate(next,{zone}).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-05-31 08:00');
  const future=nextOccurrence(now,zone,{kind:'daily',hour:5,minute:0});expect(future.getTime()).toBeGreaterThan(now.getTime());
});
it('invalid recurrence does not silently invent weekdays or monthly day',()=>{
  expect(recurrenceSchema.safeParse({kind:'weekly',hour:8,minute:0}).success).toBe(false);
  expect(recurrenceSchema.safeParse({kind:'monthly',hour:8,minute:0}).success).toBe(false);
});
