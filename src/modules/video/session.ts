import type { PoolClient } from 'pg';

export interface NormalizedVideoResult {
  id: string;
  videoRef?: string | undefined;
  title: string;
  webpageUrl: string;
  duration?: number | undefined;
  durationSeconds?: number | undefined;
  provider: string;
  thumbnailUrl?: string | undefined;
  uploader?: string | undefined;
  description?: string | undefined;
  downloadable?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface VideoSearchSession {
  id: string;
  chatId: string;
  actorId: string;
  chat_id: string;
  actor_id: string;
  query: string;
  source: string;
  results: NormalizedVideoResult[];
  createdAt: Date;
  expiresAt: Date;
  created_at: Date;
  expires_at: Date;
}

export async function saveVideoSearchSession(
  c: PoolClient,
  chatId: string,
  actorId: string,
  query: string,
  source: string,
  results: NormalizedVideoResult[],
  ttlMinutes = 15
): Promise<string> {
  const normalized = results.map(r => ({
    ...r,
    duration: r.duration ?? r.durationSeconds,
    durationSeconds: r.durationSeconds ?? r.duration,
    videoRef: r.videoRef ?? r.id,
  }));
  const row = (await c.query<{ id: string }>(
    `INSERT INTO video_search_sessions (chat_id, actor_id, query, source, results, expires_at)
     VALUES ($1, $2, $3, $4, $5, clock_timestamp() + $6 * interval '1 minute')
     RETURNING id`,
    [chatId, actorId, query, source, JSON.stringify(normalized), ttlMinutes]
  )).rows[0];
  return row!.id;
}

export async function getLatestVideoSearchSession(
  c: PoolClient,
  chatId: string,
  actorId: string
): Promise<VideoSearchSession | undefined> {
  const row = (await c.query<{
    id: string;
    chat_id: string;
    actor_id: string;
    query: string;
    source: string;
    results: unknown;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, chat_id, actor_id, query, source, results, created_at, expires_at
     FROM video_search_sessions
     WHERE chat_id = $1 AND actor_id = $2 AND expires_at > clock_timestamp()
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [chatId, actorId]
  )).rows[0];

  if (!row) return undefined;
  const results = Array.isArray(row.results) ? (row.results as NormalizedVideoResult[]) : [];
  return {
    id: row.id,
    chatId: row.chat_id,
    actorId: row.actor_id,
    chat_id: row.chat_id,
    actor_id: row.actor_id,
    query: row.query,
    source: row.source,
    results,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export async function findVideoByRef(
  c: PoolClient,
  chatId: string,
  actorId: string,
  videoRef: string
): Promise<NormalizedVideoResult | undefined> {
  const rows = (await c.query<{ results: unknown }>(
    `SELECT results
     FROM video_search_sessions
     WHERE chat_id = $1 AND actor_id = $2 AND expires_at > clock_timestamp()
     ORDER BY created_at DESC`,
    [chatId, actorId]
  )).rows;

  for (const row of rows) {
    if (!Array.isArray(row.results)) continue;
    const items = row.results as NormalizedVideoResult[];
    const item = items.find(r => r && (r.videoRef === videoRef || r.id === videoRef));
    if (item) return item;
  }
  return undefined;
}
