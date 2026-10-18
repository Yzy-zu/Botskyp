import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import { product } from '../../config/product.js';
import { confirmationInputV2 } from './session-input-v2.js';
import { sessionTextV2 } from './session-input-v2.js';
import { reminderSlotUpdateV2, mergeSessionSlotsV2 } from './reminder-slots-v2.js';

export const missingSlotV2 = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('am_pm'), hour: z.number().int().min(1).max(12) }),
  z.strictObject({ kind: z.literal('choice'), field: z.string(), choices: z.array(z.string().min(1)).min(1) }),
]);
export const sessionV2Schema = z.object({
  id: z.string(), kind: z.enum(['confirm','clarify','media_collect']), actor_id: z.string(), chat_id: z.string(),
  pending_tool: z.string(), partial_args: z.record(z.string(), z.unknown()), missing_slots: z.array(missingSlotV2),
  prompt: z.string(), code: z.string(), args_hash: z.string().nullable(), logical_action_id: z.string().nullable(),
  parent_execution_id: z.string().nullable(), confirmation_id: z.string().nullable(),
  created_at: z.coerce.date(), expires_at: z.coerce.date(), status: z.enum(['active','done','cancelled','expired']), version: z.number(),
});
export type SessionV2 = z.infer<typeof sessionV2Schema>;
export type SessionDecisionV2 = { kind: 'not_consumed' | 'expired' | 'cancel' | 'confirm' }
  | { kind: 'continue' | 'update'; slots: Record<string, unknown>; missingSlots?:SessionV2['missing_slots'] }
  | { kind: 'collect' | 'finish_collection' };
export function decideSessionV2(session: SessionV2 | undefined, text: string, now: Date, hasAttachment = false): SessionDecisionV2 {
  if (!session || session.status !== 'active') return { kind: 'not_consumed' };
  if (session.expires_at <= now) return { kind: 'expired' };
  const confirmation = confirmationInputV2(text);
  if (confirmation === 'cancel') return { kind: 'cancel' };
  if (session.kind === 'confirm') return { kind: confirmation };
  if (session.kind === 'media_collect') return { kind: /^(?:(?:que|pues) )?(?:ya(?: (?:son|estan) tod[oa]s)?|(?:esas )?son tod[oa]s|termina|terminar|hazlo|haz el pdf|listo)(?:[, ]+entiende)?$/u.test(sessionTextV2(text))?'finish_collection':hasAttachment?'collect':'not_consumed' };
  const temporal=reminderSlotUpdateV2(session,text,now);
  if(temporal)return {kind:temporal.ready?'continue':'update',slots:temporal.args,...(!temporal.ready?{missingSlots:temporal.missingSlots}:{})};
  // Multiple missing slots cannot be filled by guessing which one a fragment addresses.
  if (session.missing_slots.length !== 1) return { kind: 'not_consumed' };
  const slot = session.missing_slots[0]!;
  const normalized = sessionTextV2(text).replaceAll('.', '');
  if (slot.kind === 'choice') {
    const choices = slot.choices.filter(choice => sessionTextV2(choice) === normalized);
    return choices.length === 1 ? { kind: 'continue', slots: { [slot.field]: choices[0]! } } : { kind: 'not_consumed' };
  }
  const match = /^(?:(\d{1,2})\s*)?(am|pm|(?:de|en|por) la (?:manana|noche|tarde))$/u.exec(normalized);
  if (!match || (match[1] && Number(match[1]) !== slot.hour)) return { kind: 'not_consumed' };
  const period = /^(?:am|.*manana)$/u.test(match[2]!) ? 'am' : 'pm';
  return { kind: 'continue', slots: { period, hour24: slot.hour % 12 + (period === 'pm' ? 12 : 0) } };
}
export async function readSessionV2(c: PoolClient, actorId: string, chatId: string): Promise<SessionV2 | undefined> {
  const row = (await c.query(`SELECT * FROM sessions_v2 WHERE actor_id=$1 AND chat_id=$2 AND status='active' ORDER BY created_at DESC LIMIT 1`, [actorId, chatId])).rows[0];
  return row ? sessionV2Schema.parse(row) : undefined;
}
async function replaceForeground(c: PoolClient, actorId: string, chatId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-v2-execution-admission'))");
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`session-v2:${chatId}:${actorId}`]);
  // Superseding a confirmation also invalidates its backend handle, never just its conversational shell.
  await c.query(`UPDATE tool_confirmations_v2 SET invalidated=true WHERE id IN(
    SELECT confirmation_id FROM sessions_v2 WHERE actor_id=$1 AND chat_id=$2 AND status='active') AND consumed_execution_id IS NULL`, [actorId, chatId]);
  await c.query("UPDATE sessions_v2 SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,version=version+1 WHERE actor_id=$1 AND chat_id=$2 AND status='active'", [actorId, chatId]);
}
export async function openCollectionSessionV2(c: PoolClient, actorId: string, chatId: string, operation: 'images_pdf'|'pdf_merge', artifactIds: string[], now: Date): Promise<void> {
  await replaceForeground(c,actorId,chatId);
  await c.query(`INSERT INTO sessions_v2(actor_id,chat_id,kind,pending_tool,partial_args,prompt,code,expires_at)
    VALUES($1,$2,'media_collect','media.process',$3,'Envía los archivos y dime «terminar».','MEDIA_COLLECTION',$4)`,
    [actorId,chatId,JSON.stringify({operation,artifactIds}),new Date(now.getTime()+product.sessionMinutes*60_000)]);
}
export async function openClarificationV2(c: PoolClient, mode: Config['ROUTER_MODE'], input: {
  actorId: string; chatId: string; pendingTool: string; partialArgs: Record<string, unknown>;
  missingSlots: SessionV2['missing_slots']; prompt: string; code: string; now: Date;
}): Promise<SessionV2 | undefined> {
  if (mode !== 'v1_1') return undefined;
  const slots = z.array(missingSlotV2).min(1).parse(input.missingSlots);
  await replaceForeground(c, input.actorId, input.chatId);
  const row = (await c.query(`INSERT INTO sessions_v2(actor_id,chat_id,kind,pending_tool,partial_args,missing_slots,prompt,code,expires_at)
    VALUES($1,$2,'clarify',$3,$4,$5,$6,$7,$8) RETURNING *`, [input.actorId, input.chatId, input.pendingTool,
    JSON.stringify(input.partialArgs), JSON.stringify(slots), input.prompt, input.code, new Date(input.now.getTime() + product.sessionMinutes * 60_000)])).rows[0];
  return sessionV2Schema.parse(row);
}
export async function bindConfirmationSessionV2(c: PoolClient, mode: Config['ROUTER_MODE'], confirmationId: string, prompt: string): Promise<void> {
  if (mode !== 'v1_1') return;
  const pending = (await c.query<{ actor_id: string; chat_id: string; tool_name: string }>('SELECT actor_id,chat_id,tool_name FROM tool_confirmations_v2 WHERE id=$1', [confirmationId])).rows[0];
  if (!pending) throw new Error('Unknown confirmation');
  await replaceForeground(c, pending.actor_id, pending.chat_id);
  await c.query(`INSERT INTO sessions_v2(actor_id,chat_id,kind,pending_tool,prompt,code,args_hash,logical_action_id,parent_execution_id,confirmation_id,expires_at)
    SELECT actor_id,chat_id,'confirm',tool_name,$2,'CONFIRM_ACTION',args_hash,logical_action_id,execution_id,id,expires_at
    FROM tool_confirmations_v2 WHERE id=$1 ON CONFLICT(confirmation_id) DO NOTHING`, [confirmationId, pending.tool_name === 'bulk.nuclear' ? prompt : '¿Confirmas la operación pendiente?']);
}
/** Mutates only continuation state; never invokes a handler or consumes a confirmation. */
export async function coordinateSessionV2(c: PoolClient, mode: Config['ROUTER_MODE'], session: SessionV2, text: string, now: Date): Promise<SessionDecisionV2> {
  if (mode !== 'v1_1') return { kind: 'not_consumed' };
  await c.query("SELECT pg_advisory_xact_lock(hashtext('botsky-v2-execution-admission'))");
  const live = (await c.query('SELECT * FROM sessions_v2 WHERE id=$1 AND actor_id=$2 AND chat_id=$3 FOR UPDATE', [session.id, session.actor_id, session.chat_id])).rows[0];
  if (!live) return { kind: 'not_consumed' };
  const current = sessionV2Schema.parse(live);
  const decision = decideSessionV2(current, text, now);
  if(decision.kind==='update'){
    const args=mergeSessionSlotsV2(current.partial_args,decision.slots);
    const time=args.time as {hour:number};
    await c.query(`UPDATE sessions_v2 SET partial_args=$2,missing_slots=$3,prompt=$4,version=version+1 WHERE id=$1 AND version=$5 AND status='active'`,
      [session.id,JSON.stringify(args),JSON.stringify(decision.missingSlots ?? [{kind:'am_pm',hour:time.hour}]),decision.missingSlots?.some(s=>s.kind==='choice' && s.field==='date')?'¿Para hoy o mañana?':`¿A las ${time.hour} de la mañana o de la noche?`,current.version]);
  }
  const status = decision.kind === 'expired' ? 'expired' : decision.kind === 'cancel' ? 'cancelled' : decision.kind === 'continue' ? 'done' : undefined;
  if (status) {
    await c.query(`UPDATE sessions_v2 SET status=$2,version=version+1,
      partial_args=CASE WHEN $4::jsonb IS NULL THEN partial_args ELSE partial_args||jsonb_build_object('continuation',$4::jsonb) END,
      missing_slots=CASE WHEN $4::jsonb IS NULL THEN missing_slots ELSE '[]'::jsonb END
      WHERE id=$1 AND version=$3 AND status='active'`, [session.id, status, current.version, decision.kind==='continue'?JSON.stringify(decision.slots):null]);
    if (current.confirmation_id) await c.query('UPDATE tool_confirmations_v2 SET invalidated=true WHERE id=$1 AND consumed_execution_id IS NULL', [current.confirmation_id]);
  }
  return decision;
}
