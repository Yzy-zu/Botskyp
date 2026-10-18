import { DateTime } from 'luxon';
import type { Tool } from '../tools.js';
import { resolveSemanticTime, semanticTimeSchema, explicitClock } from '../../modules/reminders/semantic-time.js';
import { ambiguousTime, recurrenceMatchesDue, validateDue } from '../../modules/reminders/time.js';
import type { ExecutionContextV2 } from './types.js';

/** Deliberately bounded adapters. Unknown contracts fail closed instead of guessing backend arguments. */
const adapters = new Set<string>([
  'media.process','media.collect','core.ping','core.help','notes.create','notes.list','notes.edit',
  'notes.delete','reminders.create','reminders.list','reminders.edit','reminders.cancel',
  'memory.remember','memory.list','memory.forget','web.search','polls.create',
  'polls.vote','polls.results','polls.close','drive.cancel','drive.search',
  'drive.download','drive.info','drive.configure','drive.status','messaging.destinations',
  'messaging.send','bulk.broadcast','bulk.nuclear','bulk.cancel','bulk.retry',
  'bulk.resume','bulk.status','library.categories','packs.buy','packs.orders',
  'library.sync','library.sync_status','cooperacha.open','cooperacha.contribute','cooperacha.status',
  'cooperacha.cancel','library.rain','media.status','minecraft.status','minecraft.players',
  'minecraft.resources','minecraft.worlds','minecraft.addons','minecraft.logs','minecraft.config-get',
  'minecraft.config-set','minecraft.start','minecraft.stop','minecraft.restart','minecraft.backup',
  'minecraft.console','minecraft.operations','school.subjects','school.subject_save','school.subject_archive',
  'school.schedule','school.tasks','school.task_create','school.task_edit','school.task_delete',
  'school.task_attachment','school.config','school.summary_configure','xp.balance','xp.daily',
  'xp.happy','games.blackjack','games.roulette','games.join','games.play',
  'games.status','games.cancel','games.airdrop','games.claim','moderation.warns',
  'moderation.change','moderation.config','control.emergency','control.reactivate','control.maintenance_on',
  'control.maintenance_off','control.modules','diag.cuota','diag.errores',
]);
export function adapterAvailable(name: string): boolean { return adapters.has(name); }

export function legacyArguments(ctx: ExecutionContextV2, tool: Tool, input: Record<string, unknown>):
  { status: 'ok'; args: Record<string, unknown> } | { status: 'needs_clarification' | 'denied'; code: string } {
  const args = { ...input };
  if(tool.name==='games.play')args.move=({hit:'carta',stand:'plantarse',double:'doblar'} as Record<string,string>)[String(args.move)] ?? args.move;
  if(tool.name==='media.process'){
    delete args.artifactRef;
    delete args.artifactRefs;
    if(args.operation==='resend')return {status:'ok',args:{operation:'resend'}};
  }
  for (const field of ['noteRef','reminderRef','pollRef','taskRef','subjectRef','opRef','driveRef']) {
    if (args[field] !== undefined) { args.id = args[field]; delete args[field]; }
  }
  if (Array.isArray(args.destinations)) args.destinations = args.destinations.map(id => `d${String(id)}`);
  if (tool.name === 'moderation.change') {
    if (args.memberRef !== ctx.legacy.msg.mentions[0] || ctx.legacy.msg.mentions.length !== 1) return { status: 'needs_clarification', code: 'AUTHENTIC_MENTION_REQUIRED' };
    delete args.memberRef;
  }
  if (args.fact !== undefined) { args.body = args.fact; delete args.fact; }
  if (tool.name === 'memory.forget' && args.target === 'all') args.target = 'todo';
  if ('time' in args) {
    if (args.time === null && tool.name === 'school.task_edit') args.dueAt = null;
    else {
      const parsed = semanticTimeSchema.safeParse(args.time);
      if (!parsed.success) return { status: 'denied', code: 'INVALID_TIME' };
      const clock=tool.name.startsWith('reminders.')?explicitClock(ctx.legacy.msg.text):undefined;
      const value=parsed.data.kind!=='relative' && clock?{...parsed.data,...clock}:parsed.data.kind!=='relative' && ctx.callOrigin!=='session' && ambiguousTime(ctx.legacy.msg.text)?{...parsed.data,meridiem:undefined}:parsed.data;
      const sourceText=ctx.legacy.msg.text.toLocaleLowerCase('es-MX');
      const calendarDate=value.kind==='date'?DateTime.fromISO(value.date).setLocale('es-MX'):undefined;
      const explicitDay=/\b(?:hoy|ma[ñn]ana|pasado|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|esta noche|esta tarde|el \d{1,2})\b|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}/iu.test(sourceText)
        || Boolean(calendarDate?.isValid && [calendarDate.toFormat("d 'de' LLLL"),calendarDate.toFormat('d LLLL')].some(date=>sourceText.includes(date)));
      if(tool.name==='reminders.create' && ctx.callOrigin!=='session' && (value.kind==='today' || value.kind==='date') && (clock || value.meridiem || value.hour===0 || value.hour>12) && !explicitDay)return {status:'needs_clarification',code:'MISSING_DATE'};
      const time = resolveSemanticTime(value, ctx.now);
      if (time.status !== 'ok') return { status: time.status === 'needs_clarification' ? 'needs_clarification' : 'denied', code: time.code.toUpperCase() };
      // Preserve absolute semantics through confirmation; never rebase a relative date on turn B.
      args.dueAt = DateTime.fromJSDate(time.dueAt, { zone: time.timezone }).toISO();
      if (tool.name.startsWith('reminders.')) args.timezone = time.timezone;
    }
    delete args.time;
  }
  if (tool.name === 'reminders.create' || tool.name === 'reminders.edit') {
    if (!args.body || !args.dueAt) return { status: 'needs_clarification', code: !args.body ? 'MISSING_BODY' : 'MISSING_TIME' };
    const due = validateDue(String(args.dueAt), String(args.timezone ?? 'America/Mexico_City'), ctx.now);
    if (!due) return { status: 'denied', code: 'INVALID_TIME' };
    const recurrence = tool.args.safeParse(args);
    if (!recurrence.success) return { status: 'denied', code: 'INVALID_ARGUMENTS' };
    const r = recurrence.data as { recurrence?: Parameters<typeof recurrenceMatchesDue>[2] };
    if (r.recurrence && !recurrenceMatchesDue(due, 'America/Mexico_City', r.recurrence)) return { status: 'denied', code: 'INVALID_RECURRENCE' };
  }
  const parsed = tool.args.safeParse(args);
  return parsed.success ? { status: 'ok', args: parsed.data as Record<string, unknown> } : { status: 'denied', code: 'INVALID_ARGUMENTS' };
}
