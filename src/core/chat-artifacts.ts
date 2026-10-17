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
