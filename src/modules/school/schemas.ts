import { z } from 'zod';
import { DateTime } from 'luxon';
import { product } from '../../../config/product.js';
export const schoolZone='America/Mexico_City';
export const schoolId=z.string().regex(/^[1-9]\d*$/);
export const subjectName=z.string().trim().min(1).max(product.schoolSubjectChars).regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const lessonSchema=z.strictObject({subject:subjectName,weekday:z.number().int().min(1).max(7),start:clock,end:clock});
export type Lesson=z.infer<typeof lessonSchema>;
export const scheduleSchema=z.strictObject({lessons:z.array(lessonSchema).min(1).max(product.schoolLessonLimit)}).superRefine(({lessons},ctx)=>{
  const sorted=[...lessons].sort((a,b)=>a.weekday-b.weekday || a.start.localeCompare(b.start));
  for(const [i,lesson] of sorted.entries()){
    if(lesson.end<=lesson.start)ctx.addIssue({code:'custom',message:'La hora final debe ser posterior a la inicial.'});
    const previous=sorted[i-1];
    if(previous && previous.weekday===lesson.weekday && previous.end>lesson.start)ctx.addIssue({code:'custom',message:'Hay clases duplicadas o superpuestas.'});
  }
  if(new Set(lessons.map(l=>l.subject.toLocaleLowerCase('es-MX'))).size>product.schoolSubjectLimit)ctx.addIssue({code:'custom',message:'Demasiadas materias.'});
});
export type Schedule=z.infer<typeof scheduleSchema>;
export const summarySchema=z.strictObject({days:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(d=>new Set(d).size===d.length),time:clock});
export type SummarySchedule=z.infer<typeof summarySchema>;
export const weekdays=['lunes','martes','miércoles','jueves','viernes','sábado','domingo'];
export function formatSchedule(schedule:Schedule):string{
  return [...schedule.lessons].sort((a,b)=>a.weekday-b.weekday || a.start.localeCompare(b.start)).map(l=>`${weekdays[l.weekday-1]} ${l.start}–${l.end}: ${l.subject}`).join('\n');
}
export function nextClass(lessons:Lesson[],now:Date):Date|undefined{
  const local=DateTime.fromJSDate(now,{zone:schoolZone});
  return lessons.flatMap(l=>{
    const [hour,minute]=l.start.split(':').map(Number);
    let next=local.startOf('day').plus({days:(l.weekday-local.weekday+7)%7}).set({hour:hour!,minute:minute!});
    if(next.toMillis()<=now.getTime())next=next.plus({weeks:1});
    return next.isValid?[next.toJSDate()]:[];
  }).sort((a,b)=>a.getTime()-b.getTime())[0];
}
export function explicitDue(value:string,now:Date):Date|undefined{
  // Require an offset; local values without one must be clarified by the caller.
  if(!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value))return undefined;
  const parsed=DateTime.fromISO(value,{setZone:true});
  return parsed.isValid && parsed.toMillis()>now.getTime()?parsed.toJSDate():undefined;
}
export function nextSummary(schedule:SummarySchedule,after:Date):Date{
  const local=DateTime.fromJSDate(after,{zone:schoolZone});
  const [hour,minute]=schedule.time.split(':').map(Number);
  for(let day=0;day<=7;day++){
    const next=local.startOf('day').plus({days:day}).set({hour:hour!,minute:minute!});
    if(schedule.days.includes(next.weekday) && next.toMillis()>after.getTime())return next.toJSDate();
  }
  throw new Error('Invalid summary schedule');
}
