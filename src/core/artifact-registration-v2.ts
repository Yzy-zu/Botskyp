import type { PoolClient } from 'pg';
import type { Config } from '../config.js';
import type { ArtifactRecord } from './chat-artifacts.js';

type Backing = { mediaId: string; schoolId?: never } | { schoolId: string; mediaId?: never };
export type ArtifactRegistration = Backing & {
  chatId: string; actorId: string; sourceMessageId: string; origin: 'user_input' | 'bot_output';
  filename?: string; kind?: 'image' | 'audio' | 'video' | 'document' | 'sticker'; jobId?: string; outboxId?: string; parentId?: string;
};
/** Caller already owns its transaction. No downloads, new bytes, model arguments or retention extension. */
export async function registerArtifactV2(c: PoolClient, mode: Config['ROUTER_MODE'], input: ArtifactRegistration): Promise<ArtifactRecord | undefined> {
  if (mode !== 'v1_1') return undefined;
  const backing = (await c.query<{ mime: string; size: string; expires_at: Date; kind: string; artifact_index:number }>(`SELECT mime,size,expires_at,artifact_index,
    CASE WHEN mime LIKE 'image/%' THEN 'image' WHEN mime LIKE 'audio/%' THEN 'audio' WHEN mime LIKE 'video/%' THEN 'video' ELSE 'document' END kind
    FROM media_attachments WHERE id=$1 AND chat_id=$3 AND owner_id=$4 AND data IS NOT NULL AND expires_at>clock_timestamp()
    UNION ALL SELECT mime,size::bigint,expires_at,0,kind FROM school_attachments
    WHERE id=$2 AND chat_id=$3 AND owner_id=$4 AND data IS NOT NULL AND expires_at>clock_timestamp()`,
  [input.mediaId ?? null, input.schoolId ?? null, input.chatId, input.actorId])).rows[0];
  if (!backing) return undefined;
  const turn = (await c.query<{ id: string; created_at: Date; filename: string | null; kind: string | null }>(`SELECT t.id,t.created_at,
    i.payload->'attachments'->$4::int->>'fileName' filename,i.payload->'attachments'->$4::int->>'kind' kind FROM message_turns t JOIN inbox i ON i.turn_id=t.id
    LEFT JOIN user_aliases ua ON ua.alias=i.payload->>'senderId' AND ua.evidence NOT LIKE 'conflict:%'
    WHERE t.resolved_chat_id=$1 AND t.source_message_id=$2 AND coalesce(ua.user_id,i.payload->>'senderId')=$3
      AND i.status<>'failed' ORDER BY t.created_at DESC LIMIT 1`, [input.chatId, input.sourceMessageId, input.actorId,backing.artifact_index])).rows[0];
  if (!turn) return undefined;
  if (input.jobId && !(await c.query(`SELECT 1 FROM jobs WHERE id=$1 AND chat_id=$2 AND owner_id=$3 AND source_message_id=$4`,
    [input.jobId, input.chatId, input.actorId, input.sourceMessageId])).rowCount) throw new Error('Invalid artifact job');
  const kind=input.kind ?? (input.origin==='user_input' && ['image','audio','video','document','sticker'].includes(turn.kind ?? '') ? turn.kind : backing.kind);
  const artifact = (await c.query<ArtifactRecord>(`INSERT INTO chat_artifacts
    (chat_id,actor_id,turn_id,source_message_id,media_attachment_id,school_attachment_id,parent_artifact_id,kind,mime,expires_at,origin,filename,bytes,job_id,created_at,source_attachment_index)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING RETURNING *`,
  [input.chatId, input.actorId, turn.id, input.sourceMessageId, input.mediaId ?? null, input.schoolId ?? null,
    input.parentId ?? null, kind, backing.mime, backing.expires_at, input.origin, input.filename ?? (input.origin==='user_input'?turn.filename:null), backing.size, input.jobId ?? null, input.origin==='user_input'?turn.created_at:new Date(),backing.artifact_index])).rows[0]
    ?? (await c.query<ArtifactRecord>(`SELECT * FROM chat_artifacts WHERE chat_id=$1 AND actor_id=$2 AND (media_attachment_id=$3 OR school_attachment_id=$4 OR (origin='user_input' AND $5='user_input' AND source_message_id=$6 AND source_attachment_index=$7))`,
      [input.chatId, input.actorId, input.mediaId ?? null, input.schoolId ?? null,input.origin,input.sourceMessageId,backing.artifact_index])).rows[0];
  if (artifact && input.outboxId && !(await c.query("SELECT 1 FROM outbox WHERE id=$1 AND chat_id=$2 AND payload->>'attachmentId'=$3",
    [input.outboxId,input.chatId,input.mediaId ?? input.schoolId])).rowCount) throw new Error('Artifact delivery backing mismatch');
  if (artifact && input.outboxId) await c.query(`INSERT INTO artifact_deliveries(artifact_id,chat_id,outbox_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [artifact.id, input.chatId, input.outboxId]);
  return artifact;
}

/** Called after inbox identity/canonicalization. Only existing backing is registered. */
export async function registerIncomingArtifactsV2(c: PoolClient, config: Config, chatId: string, actorId: string, sourceMessageId: string): Promise<void> {
  if (config.ROUTER_MODE !== 'v1_1') return;
  const rows = (await c.query<{ media_id: string | null; school_id: string | null }>(`SELECT id media_id,NULL::uuid school_id FROM media_attachments
    WHERE chat_id=$1 AND owner_id=$2 AND source_message_id=$3 AND is_original
    UNION ALL SELECT NULL::uuid,id FROM school_attachments WHERE chat_id=$1 AND owner_id=$2 AND source_message_id=$3`, [chatId, actorId, sourceMessageId])).rows;
  for (const row of rows) await registerArtifactV2(c, config.ROUTER_MODE, {
    chatId, actorId, sourceMessageId, origin: 'user_input', ...(row.media_id ? { mediaId: row.media_id } : { schoolId: row.school_id! }),
  });
}
