import { product } from '../../config/product.js';
import type { PoolClient } from 'pg';
import type { Db } from '../db/client.js';

export type ChatArtifact = {
  id: string; chat_id: string; actor_id: string; turn_id: string; source_message_id: string;
  media_attachment_id: string | null; school_attachment_id: string | null;
  parent_artifact_id: string | null; kind: string; mime: string;
  created_at: Date; expires_at: Date;
};
/** A_LAST never returns another actor's/chat's file or an expired/cleaned backing blob. */
export async function lastChatArtifact(db: Db | PoolClient, chatId: string, actorId: string): Promise<ChatArtifact | undefined> {
  const result = await db.query<ChatArtifact>(`SELECT a.* FROM chat_artifacts a
    LEFT JOIN media_attachments m ON m.id=a.media_attachment_id
    LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
    WHERE a.chat_id=$1 AND a.actor_id=$2 AND a.expires_at>now()
      AND ((m.data IS NOT NULL AND m.expires_at>now()) OR (s.data IS NOT NULL AND s.expires_at>now()))
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [chatId, actorId]);
  return result.rows[0];
}

export type ArtifactRecord = ChatArtifact & {
  origin: 'user_input' | 'bot_output'; filename: string | null; bytes: string | null; job_id: string | null;
};
/** Live backing and delivery provenance; no name matching and no fallback across chats. */
export async function artifactsForTurn(db: Db | PoolClient, scope: { chatId: string; actorId: string; sourceMessageId: string; quotedMessageId?: string; now: Date; resolveTextResultSource?:boolean }): Promise<{
  current: ArtifactRecord[]; reply: ArtifactRecord[]; recent: ArtifactRecord[];
}> {
  const rows = (await db.query<ArtifactRecord & { is_current: boolean; is_reply: boolean }>(`SELECT a.*,
    (a.origin='user_input' AND a.source_message_id=$3 AND a.actor_id=$2) is_current,
    (coalesce(a.source_message_id=$4,false) AND a.origin='user_input' OR EXISTS(
      SELECT 1 FROM artifact_deliveries d JOIN outbox o ON o.id=d.outbox_id AND o.chat_id=d.chat_id
      WHERE d.artifact_id=a.id AND d.chat_id=$1 AND o.provider_msg_id=$4 AND o.status='sent')) is_reply
    FROM chat_artifacts a
    LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
    WHERE a.chat_id=$1 AND a.expires_at>$5
      AND ((m.data IS NOT NULL AND m.expires_at>$5) OR (s.data IS NOT NULL AND s.expires_at>$5))
      AND ((a.actor_id=$2 AND a.created_at>=$5::timestamptz-$6::bigint*interval '1 millisecond')
        OR (coalesce(a.source_message_id=$4,false) AND a.origin='user_input') OR EXISTS(
          SELECT 1 FROM artifact_deliveries d JOIN outbox o ON o.id=d.outbox_id AND o.chat_id=d.chat_id
          WHERE d.artifact_id=a.id AND d.chat_id=$1 AND o.provider_msg_id=$4 AND o.status='sent'))
      AND (a.actor_id=$2 OR EXISTS(SELECT 1 FROM chats ch WHERE ch.id=$1 AND ch.is_group))
    ORDER BY is_current DESC,is_reply DESC,a.created_at DESC,a.id DESC LIMIT $7`,
  [scope.chatId, scope.actorId, scope.sourceMessageId, scope.quotedMessageId ?? null, scope.now, product.artifactWindowMs, product.contextV2Artifacts + product.mediaMaxFiles * 2])).rows;
  let reply=rows.filter(a=>a.is_reply);
  if(!reply.length && scope.quotedMessageId && scope.resolveTextResultSource){
    // A sent textual result points to its exact retained input, never an unrelated A_LAST.
    reply=(await db.query<ArtifactRecord & {is_current:boolean;is_reply:boolean}>(`SELECT DISTINCT a.*,false is_current,true is_reply
      FROM outbox o JOIN jobs j ON j.id::text=o.payload->>'jobId' AND j.chat_id=o.chat_id
      CROSS JOIN LATERAL jsonb_array_elements(j.payload->'sources') source
      JOIN chat_artifacts a ON (a.media_attachment_id::text=source->>'storedId' OR a.school_attachment_id::text=source->>'schoolStoredId')
      LEFT JOIN media_attachments m ON m.id=a.media_attachment_id LEFT JOIN school_attachments s ON s.id=a.school_attachment_id
      WHERE o.chat_id=$1 AND o.provider_msg_id=$3 AND o.status='sent' AND o.kind='media_text'
        AND j.kind='media' AND j.owner_id=$2 AND j.status='done' AND j.payload->>'operation' IN ('ocr','qr_read','read','transcribe')
        AND a.chat_id=$1 AND a.actor_id=$2 AND a.expires_at>$4
        AND ((m.data IS NOT NULL AND m.expires_at>$4) OR (s.data IS NOT NULL AND s.expires_at>$4))
      ORDER BY a.created_at DESC,a.id DESC LIMIT $5`,[scope.chatId,scope.actorId,scope.quotedMessageId,scope.now,product.mediaMaxFiles])).rows;
  }
  return { current: rows.filter(a => a.is_current), reply, recent: rows.filter(a => a.actor_id === scope.actorId).sort((a,b)=>b.created_at.getTime()-a.created_at.getTime() || b.id.localeCompare(a.id)).slice(0, product.contextV2Artifacts) };
}
