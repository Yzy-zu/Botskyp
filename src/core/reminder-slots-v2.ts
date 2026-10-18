function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

export function mergeSessionSlotsV2(args: Record<string, unknown>, slots: Record<string, unknown>): Record<string, unknown> {
  const time = args.time;
  if (isRecord(time) && 'period' in slots) return { ...args, time: { ...time, meridiem: slots.period } };
  return { ...args, ...slots };
}

/** Merge structured partial_args with structured modelArgs during an active clarification session. Zero text regex. */
export function mergeClarificationArgsV2(partialArgs: Record<string, unknown>, modelArgs: unknown): unknown {
  if (!isRecord(modelArgs)) return modelArgs;
  const allowed = ['body', 'time', 'recurrence'] as const;
  const base = Object.fromEntries(allowed.filter(k => partialArgs[k] !== undefined).map(k => [k, partialArgs[k]]));
  const merged: Record<string, unknown> = { ...base, ...modelArgs };
  if (isRecord(partialArgs.time) && isRecord(modelArgs.time)) {
    const prev = partialArgs.time, next = modelArgs.time;
    if (next.kind === 'relative') {
      merged.time = next;
    } else {
      const prevHour = typeof prev.hour === 'number' ? prev.hour : undefined;
      const nextHour = typeof next.hour === 'number' ? next.hour : prevHour;
      const same12h = prevHour !== undefined && nextHour !== undefined && (prevHour % 12) === (nextHour % 12);
      const meridiem = next.meridiem ?? (same12h ? prev.meridiem : undefined);
      const baseTime = next.kind === 'clock' && prev.kind === 'date' && typeof prev.date === 'string'
        ? { ...next, kind: 'date', date: prev.date }
        : next.kind === 'clock' && typeof prev.kind === 'string' && ['today', 'tomorrow', 'day_after_tomorrow'].includes(prev.kind)
          ? { ...next, kind: prev.kind }
          : { ...next };
      merged.time = {
        ...baseTime,
        ...(nextHour !== undefined ? { hour: nextHour } : {}),
        minute: typeof next.minute === 'number' ? next.minute : (typeof prev.minute === 'number' ? prev.minute : 0),
        ...(meridiem !== undefined ? { meridiem } : {}),
      };
    }
  } else if (!isRecord(partialArgs.time) && isRecord(modelArgs.time) && modelArgs.time.kind === 'clock' && typeof partialArgs.day === 'string' && ['today', 'tomorrow', 'day_after_tomorrow'].includes(partialArgs.day)) {
    merged.time = { ...modelArgs.time, kind: partialArgs.day };
  }
  return merged;
}
