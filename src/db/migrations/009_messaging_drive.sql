CREATE TABLE messaging_destinations (
  id bigserial PRIMARY KEY, target_id text NOT NULL UNIQUE,
  is_group boolean NOT NULL, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bulk_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('message','broadcast','nuclear')),
  chat_id text NOT NULL, actor_id text NOT NULL, source_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','paused','done','cancelled','expired')),
  params jsonb NOT NULL, args_hash text NOT NULL, reason text, job_id bigint REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  confirmed_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(chat_id,actor_id,source_id,kind)
);
CREATE UNIQUE INDEX nuclear_active ON bulk_ops(chat_id) WHERE kind='nuclear' AND status IN ('queued','running','paused');
CREATE TABLE bulk_targets (
  id bigserial PRIMARY KEY, op_id uuid NOT NULL REFERENCES bulk_ops(id), position int NOT NULL,
  target_id text NOT NULL, label text NOT NULL, text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped','uncertain')),
  outbox_id bigint UNIQUE REFERENCES outbox(id), retries int NOT NULL DEFAULT 0, detail text, done_at timestamptz,
  UNIQUE(op_id,position)
);
CREATE INDEX bulk_pending ON bulk_ops(next_at) WHERE status IN ('queued','running','paused');
CREATE TABLE drive_entries (
  id bigserial PRIMARY KEY, chat_id text NOT NULL, actor_id text NOT NULL, remote_id text NOT NULL,
  name text NOT NULL, mime text NOT NULL, size bigint NOT NULL, checksum text,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  UNIQUE(chat_id,actor_id,remote_id)
);
CREATE TABLE drive_operations (
  job_id bigint PRIMARY KEY REFERENCES jobs(id), remote_id text,
  phase text NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','reading','creating','sharing','done','failed','review')),
  sha256 text, detail text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX drive_job_request ON jobs(chat_id,owner_id,source_message_id) WHERE kind='drive';
