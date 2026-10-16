-- Queue commits before any remote effect. Unknown outcomes are never replayed.
CREATE TABLE minecraft_operations (
 id uuid PRIMARY KEY, chat_id text NOT NULL, actor_id text NOT NULL,
 source_id text NOT NULL, request jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','done','review','cancelled')),
 response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), started_at timestamptz,
 finished_at timestamptz, UNIQUE(chat_id,actor_id,source_id)
);
CREATE UNIQUE INDEX minecraft_one_write ON minecraft_operations ((true)) WHERE status IN ('queued','sending','review');
