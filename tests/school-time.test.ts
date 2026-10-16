import { it,expect } from 'vitest';
import { DateTime } from 'luxon';
import { scheduleSchema,summarySchema,nextClass,nextSummary,explicitDue } from '../src/modules/school/schemas.js';
const lesson={subject:'Matemáticas',weekday:1,start:'08:00',end:'09:00'};
it('validates strict schedules, weekdays, times, names and overlapping classes',()=>{
  expect(scheduleSchema.safeParse({lessons:[lesson,{...lesson,start:'09:00',end:'10:00'}]}).success).toBe(true);
  for(const bad of [{...lesson,weekday:0},{...lesson,start:'25:00'},{...lesson,end:'07:00'},{...lesson,start:'8:00'},{...lesson,subject:'x\nowner'},{...lesson,actorId:'100'}])expect(scheduleSchema.safeParse({lessons:[bad]}).success).toBe(false);
  expect(scheduleSchema.safeParse({lessons:[lesson,lesson]}).success).toBe(false);
  expect(scheduleSchema.safeParse({lessons:[lesson,{...lesson,start:'08:30',end:'10:00'}]}).success).toBe(false);
  expect(scheduleSchema.safeParse({lessons:[],chatId:'forged'}).success).toBe(false);
});
it('chooses the next actual weekly class in CDMX across UTC midnight and week boundaries',()=>{
  const now=new Date('2026-10-19T05:50:00Z'); // Sunday 23:50 CDMX, Monday UTC.
  expect(nextClass([lesson],now)?.toISOString()).toBe('2026-10-19T14:00:00.000Z');
  expect(nextClass([lesson],new Date('2026-10-19T14:00:00Z'))?.toISOString()).toBe('2026-10-26T14:00:00.000Z');
  expect(nextClass([],now)).toBeUndefined();
});
it('preserves explicit offsets, rejects past/invalid/zoneless dates without inventing calendar dates',()=>{
  const now=new Date('2026-10-16T12:00:00Z');
  expect(explicitDue('2026-10-16T08:00:00-06:00',now)?.toISOString()).toBe('2026-10-16T14:00:00.000Z');
  for(const date of ['2026-02-30T08:00:00-06:00','2026-10-15T08:00:00-06:00','2026-10-16T08:00:00','mañana'])expect(explicitDue(date,now)).toBeUndefined();
});
it('schedules summaries at the requested CDMX hour, skipping all missed occurrences',()=>{
  const schedule={days:[1,2,3,4,5],time:'07:00'};
  const next=nextSummary(schedule,new Date('2026-10-16T20:00:00Z'));
  expect(next.toISOString()).toBe('2026-10-19T13:00:00.000Z');
  expect(DateTime.fromJSDate(next).setZone('America/Mexico_City').hour).toBe(7);
  expect(summarySchema.safeParse({days:[1,1],time:'07:00'}).success).toBe(false);
});
