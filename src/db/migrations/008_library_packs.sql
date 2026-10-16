-- Persistent library content is independent of expiring media attachments.
CREATE TABLE library_blobs (
  sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  mime text NOT NULL, size integer NOT NULL CHECK(size>0), data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(octet_length(data)=size)
);
CREATE TABLE library_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL CHECK(source IN ('local','drive')),
  path text NOT NULL, category text NOT NULL, sha256 text NOT NULL REFERENCES library_blobs(sha256),
  enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source,path)
);
CREATE TABLE library_syncs (
  id bigserial PRIMARY KEY, source text NOT NULL CHECK(source IN ('local','drive')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
  actor_id text NOT NULL, requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz, finished_at timestamptz, item_count integer, error text
);
CREATE UNIQUE INDEX library_sync_active ON library_syncs((true)) WHERE status IN ('queued','running');
CREATE TABLE pack_orders (
  id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id text NOT NULL, destination text, source_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('purchase','cooperacha','airdrop','rain')),
  price integer NOT NULL CHECK(price>=0), happy boolean NOT NULL, category text,
  status text NOT NULL CHECK(status IN ('reserved','queued','confirmed','refunded','failed','pending_review','cancelled')),
  config_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(kind,chat_id,user_id,source_id)
);
CREATE TABLE pack_order_items (
  order_id uuid NOT NULL REFERENCES pack_orders(id) ON DELETE CASCADE, position integer NOT NULL,
  item_id uuid NOT NULL REFERENCES library_items(id), sha256 text NOT NULL REFERENCES library_blobs(sha256),
  outbox_id bigint UNIQUE REFERENCES outbox(id), PRIMARY KEY(order_id,position), UNIQUE(order_id,sha256)
);
CREATE TABLE cooperachas (
  id uuid PRIMARY KEY, chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  owner_id text NOT NULL, source_id text NOT NULL, goal integer NOT NULL CHECK(goal BETWEEN 50 AND 50000),
  total integer NOT NULL DEFAULT 0 CHECK(total>=0 AND total<=goal),
  order_id uuid NOT NULL UNIQUE REFERENCES pack_orders(id),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled','expired')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancel_source_id text, cancel_actor_id text, UNIQUE(chat_id,cancel_actor_id,cancel_source_id),
  UNIQUE(chat_id,owner_id,source_id)
);
CREATE UNIQUE INDEX cooperacha_one_open ON cooperachas(chat_id) WHERE status='open';
CREATE TABLE cooperacha_contributions (
  id uuid PRIMARY KEY, cooperacha_id uuid NOT NULL REFERENCES cooperachas(id) ON DELETE CASCADE,
  user_id text NOT NULL, source_id text NOT NULL, amount integer NOT NULL CHECK(amount>0),
  refund integer CHECK(refund>=0 AND refund<=amount), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(cooperacha_id,user_id,source_id)
);
CREATE TABLE library_events (
  id bigserial PRIMARY KEY, order_id uuid REFERENCES pack_orders(id) ON DELETE CASCADE,
  actor_id text NOT NULL, chat_id text NOT NULL, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Isolate the two automation kinds and preserve all existing school schedules.
ALTER TABLE automations DROP CONSTRAINT automations_kind_check;
ALTER TABLE automations ADD CONSTRAINT automations_kind_check CHECK(kind IN ('school_summary','content_rain'));
ALTER TABLE automations DROP CONSTRAINT automations_catch_up_check;
ALTER TABLE automations ADD CONSTRAINT automations_catch_up_check CHECK((kind='school_summary' AND catch_up) OR (kind='content_rain' AND NOT catch_up));
ALTER TABLE cooperacha_contributions ADD COLUMN chat_id text NOT NULL REFERENCES chats(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX cooperacha_contribution_replay ON cooperacha_contributions(chat_id,user_id,source_id);
