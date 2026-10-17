import { z } from 'zod';
import { transaction, type Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { Delivery } from '../wa/types.js';
import { mediaAllowed } from '../modules/media/access.js';
import { extension, safeName, validateBytes } from '../modules/media/catalog.js';
import type { ToolCtx } from './tools.js';
import type { SafeRefs } from './safe-refs.js';
import { loadExecutionContext } from './policy-v2/context.js';
import { resolveArtifactForOperation } from './artifact-resolution-v2.js';

/** Internal media capability, not tool #99. Only enqueues an existing blob, never a worker job. */
export async function resendArtifactV2(ctx: ToolCtx, safeRefMap: SafeRefs, ref = 'A_LAST'): Promise<{ status: 'queued'; outboxId: string } | { status: 'denied' | 'not_found' | 'incompatible' | 'needs_clarification' }> {
  if (ctx.config.ROUTER_MODE !== 'v1_1') return { status: 'denied' };
  return transaction(ctx.db, async c => {
    const backend = await loadExecutionContext({ ...ctx, c }, { callOrigin: 'internal', safeRefMap });
    if (!await mediaAllowed(c, ctx.config, backend.chatId, backend.actorId)) return { status: 'denied' };
    const selected = await resolveArtifactForOperation('resend', { c, ...backend,
      ...(backend.legacy.msg.quoted ? { quotedMessageId: backend.legacy.msg.quoted.id } : {}), safeRefMap }, ref);
    if (selected.status !== 'ok') return selected;
    const a = selected.artifact;
    const row = (await c.query<{ id: string }>(`INSERT INTO outbox(chat_id,kind,payload,dedupe_key)
      VALUES($1,'artifact_resend',$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING id`,
    [backend.chatId, JSON.stringify({ text: '', sourceId: backend.sourceMessageId, artifactId: a.id, actorId: backend.actorId,
      quotedMessageId: backend.legacy.msg.quoted?.id ?? null }), `artifact-resend:${backend.chatId}:${backend.actorId}:${backend.sourceMessageId}`])).rows[0]!;
    await c.query('INSERT INTO artifact_deliveries(artifact_id,chat_id,outbox_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [a.id, backend.chatId, row.id]);
    return { status: 'queued', outboxId: row.id };
  });
}
const payload = z.object({ artifactId: z.uuid(), actorId: z.string(), quotedMessageId: z.string().nullable() });
/** Recheck delivery authority and retention immediately before the existing outbox crosses the network. */
export async function artifactResendDelivery(db: Db, config: Config, row: { id: string; chat_id: string; payload: unknown }): Promise<Delivery['media'] | undefined> {
  if (config.ROUTER_MODE !== 'v1_1') return undefined;
  const p = payload.safeParse(row.payload);
  if (!p.success) return undefined;
  return transaction(db, async c => {
    if (!await mediaAllowed(c, config, row.chat_id, p.data.actorId)) return undefined;
    const a = (await c.query<{ data: Buffer; mime: string; kind: string }>(`SELECT coalesce(m.data,s.data) data,a.mime,a.kind FROM artifact_deliveries d
      JOIN chat_artifacts a ON a.id=d.artifact_id AND a.chat_id=d.chat_id JOIN chats ch ON ch.id=a.chat_id
      LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
      WHERE d.outbox_id=$1 AND d.chat_id=$2 AND a.id=$3 AND a.expires_at>clock_timestamp()
      AND ((m.data IS NOT NULL AND m.expires_at>clock_timestamp()) OR (s.data IS NOT NULL AND s.expires_at>clock_timestamp()))
      AND (a.actor_id=$4 OR (ch.is_group AND $5::text IS NOT NULL AND (
        (a.origin='user_input' AND a.source_message_id=$5) OR EXISTS(
          SELECT 1 FROM artifact_deliveries rd JOIN outbox ro ON ro.id=rd.outbox_id AND ro.chat_id=rd.chat_id
          WHERE rd.artifact_id=a.id AND rd.chat_id=$2 AND ro.provider_msg_id=$5 AND ro.status='sent'))))`,
    [row.id, row.chat_id, p.data.artifactId, p.data.actorId, p.data.quotedMessageId])).rows[0];
    if (!a) return undefined;
    try { validateBytes(a.data, a.mime); } catch { return undefined; }
    const kind = z.enum(['image','video','audio','sticker','document']).safeParse(a.kind);
    if (!kind.success) return undefined;
    return { kind: kind.data, mime: a.mime, base64: a.data.toString('base64'), fileName: safeName(p.data.artifactId, extension(a.mime)) };
  });
}
