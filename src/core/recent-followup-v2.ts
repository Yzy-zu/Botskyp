import { product } from '../../config/product.js';
import { SafeRefs } from './safe-refs.js';
import type { PoolClient } from 'pg';

/** The last successful tool must have created/edited this exact reminder. No arbitrary latest-row fallback. */
export async function recentReminderV2(c: PoolClient, chatId: string, actorId: string, now: Date): Promise<{ref:string;safeRefs:SafeRefs}|undefined> {
  const row=(await c.query<{id:string}>(`WITH latest AS (
    SELECT tool_name,result_json FROM tool_executions WHERE chat_id=$1 AND actor_id=$2 AND status='ok'
      AND created_at>$3::timestamptz-$4::int*interval '1 millisecond' ORDER BY created_at DESC,id DESC LIMIT 1)
    SELECT r.id::text FROM latest e JOIN reminders r ON r.id::text=e.result_json->'data'->>'reminderId'
    WHERE e.tool_name IN ('reminders.create','reminders.edit') AND r.chat_id=$1 AND r.owner_id=$2 AND r.status='pending'`,
    [chatId,actorId,now,product.recentOperationMs])).rows[0];
  if(!row)return;
  const safeRefs=new SafeRefs([{kind:'reminderRef',id:row.id,chatId,label:'Recordatorio recién creado',access:{visibility:'personal',ownerId:actorId}}]);
  return {safeRefs,ref:safeRefs.list({chatId,actorId})[0]!.ref};
}
export function mediaFollowupV2(text: string): boolean {
  return /(?:no me (?:llego|llegó|enviaste|mandaste|lo mandaste)|qué pasó con mi|que paso con mi|fall[oó]\??)/iu.test(text);
}
export function mediaHistoryRequestV2(text: string): boolean {
  return /(?:mis trabajos|mis archivos|qu[eé] archivos has procesado|[uú]ltimos trabajos|historial de (?:archivos|trabajos))/iu.test(text);
}
export async function hasRecentMediaFollowupV2(c: PoolClient, chatId: string, actorId: string, now: Date, text: string): Promise<boolean> {
  if(!mediaFollowupV2(text))return false;
  const explicit=/\b(?:pdf|archivo|foto|sticker|video|audio|conversi[oó]n)\b/iu.test(text);
  return Boolean((await c.query(`SELECT 1 FROM jobs j WHERE j.kind='media' AND j.chat_id=$1 AND j.owner_id=$2
    AND j.created_at>$3::timestamptz-$4::bigint*interval '1 millisecond'
    AND (NOT $5::boolean OR j.payload->>'operation' IN ('office_pdf','images_pdf','pdf_merge','pdf_compress','pdf_crop'))
    AND ($6::boolean OR NOT EXISTS(SELECT 1 FROM tool_executions e WHERE e.chat_id=$1 AND e.actor_id=$2
      AND e.created_at>j.created_at AND e.status IN ('ok','queued') AND e.tool_name NOT IN ('media.process','media.collect','media.status')))
    LIMIT 1`,[chatId,actorId,now,product.artifactWindowMs,/\bpdf\b/iu.test(text),explicit])).rowCount);
}
