-- Additive Phase 5 queue and scoped retained artifacts. Existing data is untouched.
ALTER TABLE jobs ADD COLUMN source_message_id text;
ALTER TABLE jobs ADD COLUMN outbox_id bigint REFERENCES outbox(id);
ALTER TABLE jobs ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX media_job_request ON jobs(chat_id,owner_id,source_message_id) WHERE kind='media';
CREATE INDEX media_jobs_active ON jobs(owner_id,status) WHERE kind='media' AND status IN ('queued','running');
CREATE TABLE media_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL REFERENCES chats(id), owner_id text NOT NULL,
  source_message_id text, job_id bigint REFERENCES jobs(id),
  artifact_index int NOT NULL DEFAULT 0, is_original boolean NOT NULL, mime text NOT NULL, extension text NOT NULL,
  size bigint NOT NULL CHECK(size>0), sha256 text NOT NULL,
  data bytea, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id,owner_id,source_message_id,is_original), UNIQUE(job_id,artifact_index,is_original)
);
CREATE INDEX media_retention ON media_attachments(expires_at) WHERE data IS NOT NULL;

ALTER TABLE sessions DROP CONSTRAINT sessions_kind_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_check CHECK(kind IN ('confirm','clarify','game','media'));
