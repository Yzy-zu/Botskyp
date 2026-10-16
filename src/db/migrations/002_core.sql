CREATE TABLE sessions (
  id bigserial PRIMARY KEY, chat_id text NOT NULL, owner_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('confirm','clarify')), state jsonb NOT NULL,
  version int NOT NULL DEFAULT 1, accepted_inputs jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','expired')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_foreground ON sessions(chat_id,owner_id) WHERE status='active';
CREATE TABLE context_msgs (
  id bigserial PRIMARY KEY, chat_id text NOT NULL, user_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('user','bot')), text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_pair ON context_msgs(chat_id,user_id,id DESC);
CREATE TABLE notes (
  id bigserial PRIMARY KEY, chat_id text NOT NULL, author_id text NOT NULL, body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  search tsvector GENERATED ALWAYS AS (to_tsvector('spanish',body)) STORED
);
CREATE INDEX notes_search ON notes USING gin(search);
CREATE TABLE reminders (
  id bigserial PRIMARY KEY, chat_id text NOT NULL, owner_id text NOT NULL, body text NOT NULL,
  due_at timestamptz NOT NULL, timezone text NOT NULL, recurrence jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','sent','failed','cancelled')),
  outbox_id bigint REFERENCES outbox(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due ON reminders(due_at) WHERE status IN ('pending','queued');
CREATE TABLE user_memories (
  id bigserial PRIMARY KEY, user_id text NOT NULL, body text NOT NULL CHECK(length(body)<=200), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llm_usage (
  id bigserial PRIMARY KEY, actor_id text NOT NULL, model text NOT NULL, purpose text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), status text NOT NULL DEFAULT 'reserved',
  input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0
);
CREATE INDEX llm_usage_time ON llm_usage(at,actor_id);
CREATE TABLE llm_cooldowns (model text PRIMARY KEY, until_at timestamptz NOT NULL);
CREATE TABLE audit_log (
 id bigserial PRIMARY KEY, actor_id text NOT NULL, chat_id text NOT NULL, action text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
);
