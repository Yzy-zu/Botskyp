CREATE TABLE users (
  id text PRIMARY KEY, display_name text, flags jsonb NOT NULL DEFAULT '{}',
  private_ok_manual boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_aliases (
  alias text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  evidence text NOT NULL, verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chats (
  id text PRIMARY KEY, is_group boolean NOT NULL, enabled boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE group_memberships (
  chat_id text NOT NULL REFERENCES chats(id), user_id text NOT NULL REFERENCES users(id),
  is_admin boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(chat_id,user_id)
);
CREATE TABLE seen_events (
  provider_msg_id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now()
);
-- Acknowledged webhooks survive a crash before the application processes them.
CREATE TABLE inbox (
  id bigserial PRIMARY KEY, provider_msg_id text UNIQUE NOT NULL REFERENCES seen_events(provider_msg_id),
  chat_id text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','done','failed')),
  received_at timestamptz NOT NULL DEFAULT now(), error text
);
CREATE INDEX inbox_queued ON inbox(id) WHERE status='queued';
CREATE TABLE outbox (
  id bigserial PRIMARY KEY, chat_id text NOT NULL, kind text NOT NULL DEFAULT 'text', payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','sent','failed','uncertain')),
  dedupe_key text NOT NULL UNIQUE, provider_msg_id text, attempts int NOT NULL DEFAULT 0,
  reconcile_attempts int NOT NULL DEFAULT 0, next_try_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, sending_at timestamptz,
  last_error text, notified boolean NOT NULL DEFAULT false
);
CREATE INDEX outbox_pending ON outbox(next_try_at,id) WHERE status IN ('queued','uncertain');
CREATE TABLE jobs (
  id bigserial PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  attempts int NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(),
  chat_id text, owner_id text, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE error_log (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), where_ text, msg_id text, detail text);
CREATE TABLE system_flags (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE worker_heartbeat (id boolean PRIMARY KEY DEFAULT true CHECK(id), at timestamptz NOT NULL DEFAULT now());
