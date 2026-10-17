-- R4 is additive and dormant in v1/shadow. Real bytes remain in existing backing tables.
ALTER TABLE chat_artifacts ADD COLUMN origin text NOT NULL DEFAULT 'user_input' CHECK(origin IN ('user_input','bot_output'));
ALTER TABLE chat_artifacts ADD COLUMN filename text;
ALTER TABLE chat_artifacts ADD COLUMN bytes bigint CHECK(bytes>0);
ALTER TABLE chat_artifacts ADD COLUMN job_id bigint REFERENCES jobs(id);
CREATE UNIQUE INDEX artifact_media_backing ON chat_artifacts(media_attachment_id) WHERE media_attachment_id IS NOT NULL;
CREATE UNIQUE INDEX artifact_school_backing ON chat_artifacts(school_attachment_id) WHERE school_attachment_id IS NOT NULL;
CREATE UNIQUE INDEX artifact_incoming_once ON chat_artifacts(chat_id,actor_id,source_message_id,kind) WHERE origin='user_input';
ALTER TABLE chat_artifacts ADD CONSTRAINT artifact_chat_identity UNIQUE(id,chat_id);
ALTER TABLE outbox ADD CONSTRAINT outbox_chat_identity UNIQUE(id,chat_id);
CREATE TABLE artifact_deliveries (
  artifact_id uuid NOT NULL, chat_id text NOT NULL, outbox_id bigint NOT NULL,
  PRIMARY KEY(outbox_id),
  FOREIGN KEY(artifact_id,chat_id) REFERENCES chat_artifacts(id,chat_id),
  FOREIGN KEY(outbox_id,chat_id) REFERENCES outbox(id,chat_id)
);
CREATE INDEX artifact_source_message ON chat_artifacts(chat_id,source_message_id) WHERE origin='user_input';
CREATE INDEX artifact_delivery_lookup ON artifact_deliveries(artifact_id,chat_id);
CREATE INDEX artifact_provider_reply ON outbox(chat_id,provider_msg_id) WHERE status='sent';
-- Reuse the established short-lived conversation store for bounded textual results.
ALTER TABLE context_msgs ADD COLUMN result_kind text CHECK(result_kind IN ('ocr','qr_read','transcribe','read'));
ALTER TABLE context_msgs ADD COLUMN result_key text;
CREATE UNIQUE INDEX context_result_once ON context_msgs(chat_id,user_id,result_key) WHERE result_key IS NOT NULL;
CREATE TABLE sessions_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id text NOT NULL, chat_id text NOT NULL REFERENCES chats(id),
  kind text NOT NULL CHECK(kind IN ('confirm','clarify','media_collect')),
  pending_tool text NOT NULL, partial_args jsonb NOT NULL DEFAULT '{}', missing_slots jsonb NOT NULL DEFAULT '[]',
  prompt text NOT NULL, code text NOT NULL,
  args_hash text, logical_action_id uuid, parent_execution_id uuid,
  confirmation_id uuid UNIQUE REFERENCES tool_confirmations_v2(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','expired')),
  version int NOT NULL DEFAULT 1,
  CHECK(expires_at>created_at),
  CHECK(kind<>'confirm' OR (confirmation_id IS NOT NULL AND args_hash IS NOT NULL AND logical_action_id IS NOT NULL AND parent_execution_id IS NOT NULL))
);
CREATE UNIQUE INDEX session_v2_foreground ON sessions_v2(chat_id,actor_id) WHERE status='active';
