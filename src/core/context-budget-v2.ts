import { product } from '../../config/product.js';
import type { ContextEnvelopeV2 } from './context-v2-types.js';
export const MAX_CONTEXT_CHARS = product.contextV2Chars;
/** Whole nodes only, deterministic low-priority eviction. Never slice serialized JSON or a reference. */
export function budgetContextV2(envelope: ContextEnvelopeV2): ContextEnvelopeV2 {
  const e = structuredClone(envelope), r = e.REFERENCE_DATA;
  const size = () => JSON.stringify(e).length;
  while(size()>MAX_CONTEXT_CHARS && r.recentDialogue?.length)r.recentDialogue.shift();
  const lists = [r.destinations ?? [], r.driveEntries ?? [], r.operations ?? [], r.recentEvents, r.recentResults, r.recentArtifacts, r.personalMemories, r.notes, r.reminders, r.school, r.members];
  for (const list of lists) while (size() > MAX_CONTEXT_CHARS && list.length) list.pop();
  for (const key of ['cooperacha','poll','game','visionArtifact','currentArtifact','currentAttachment'] as const) {
    if (size() > MAX_CONTEXT_CHARS) delete r[key];
  }
  if (size() > MAX_CONTEXT_CHARS) delete r.quotedMessage;
  if (size() > MAX_CONTEXT_CHARS) delete e.CURRENT_USER_TURN.quotedText;
  // Preserve the current instruction intact. Oversized input is rejected, not silently changed.
  if (size() > MAX_CONTEXT_CHARS) throw new Error('CURRENT_TURN_EXCEEDS_CONTEXT_BUDGET');
  return e;
}
