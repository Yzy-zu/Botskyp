CREATE TABLE video_search_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL REFERENCES chats(id),
  actor_id text NOT NULL,
  query text NOT NULL,
  source text NOT NULL,
  results jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX video_search_sessions_scope ON video_search_sessions(chat_id, actor_id, expires_at);
