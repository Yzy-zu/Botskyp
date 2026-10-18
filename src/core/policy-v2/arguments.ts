import { DateTime } from 'luxon';
import type { Tool } from '../tools.js';
import { resolveSemanticTime, semanticTimeSchema } from '../../modules/reminders/semantic-time.js';
import { recurrenceMatchesDue, validateDue } from '../../modules/reminders/time.js';
import type { ExecutionContextV2 } from './types.js';

import { modelArgsSchemas } from '../model-args.js';

/** Every registered public model contract has a fail-closed schema translation below. */
export function adapterAvailable(name: string): boolean {
  return Object.hasOwn(modelArgsSchemas,name) && name!=='bulk.confirm' && name!=='school.schedule_commit';
}

export function legacyArguments(ctx: ExecutionContextV2, tool: Tool, input: Record<string, unknown>):
  { status: 'ok'; args: Record<string, unknown> } | { status: 'needs_clarification' | 'denied'; code: string } {
  const args = { ...input };
  if(tool.name==='media.collect'){
    const operation=tool.args.safeParse({operation:args.operation});
    return operation.success?{status:'ok',args:{...operation.data as Record<string,unknown>,action:args.action ?? 'start'}}:{status:'denied',code:'INVALID_ARGUMENTS'};
  }
  if(tool.name==='drive.upload' || tool.name==='school.schedule_import')delete args.artifactRef;
  if(tool.name==='school.destination'){args.targetGroupId=args.destinationRef;delete args.destinationRef;}
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
      const time = resolveSemanticTime(parsed.data, ctx.now);
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
