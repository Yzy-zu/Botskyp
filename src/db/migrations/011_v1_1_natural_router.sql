-- Durable message identity outlives the ephemeral inbox/seen_events retention.
CREATE TABLE message_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL, resolved_chat_id text NOT NULL,
  provider_msg_id text NOT NULL, source_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id,provider_msg_id), UNIQUE(id,chat_id,provider_msg_id),
  UNIQUE(id,resolved_chat_id,source_message_id)
);
ALTER TABLE inbox ADD COLUMN turn_id uuid;
INSERT INTO message_turns(chat_id,resolved_chat_id,provider_msg_id,source_message_id,created_at)
  SELECT chat_id,chat_id,provider_msg_id,coalesce(payload->>'id',provider_msg_id),received_at FROM inbox;
UPDATE inbox i SET turn_id=t.id FROM message_turns t
  WHERE t.chat_id=i.chat_id AND t.provider_msg_id=i.provider_msg_id;
ALTER TABLE inbox ALTER COLUMN turn_id SET NOT NULL;
ALTER TABLE inbox ADD CONSTRAINT inbox_turn_scope
  FOREIGN KEY(turn_id,chat_id,provider_msg_id) REFERENCES message_turns(id,chat_id,provider_msg_id);
CREATE UNIQUE INDEX inbox_turn_id ON inbox(turn_id);

CREATE FUNCTION assign_inbox_turn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved message_turns;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.turn_id,NEW.chat_id,NEW.provider_msg_id,NEW.payload->>'id') IS DISTINCT FROM
       (OLD.turn_id,OLD.chat_id,OLD.provider_msg_id,OLD.payload->>'id') THEN
      RAISE EXCEPTION 'Inbox message identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  INSERT INTO message_turns(chat_id,resolved_chat_id,provider_msg_id,source_message_id)
    VALUES(NEW.chat_id,NEW.chat_id,NEW.provider_msg_id,coalesce(NEW.payload->>'id',NEW.provider_msg_id))
    ON CONFLICT(chat_id,provider_msg_id) DO NOTHING;
  SELECT * INTO STRICT saved FROM message_turns
    WHERE chat_id=NEW.chat_id AND provider_msg_id=NEW.provider_msg_id;
  IF saved.source_message_id IS DISTINCT FROM coalesce(NEW.payload->>'id',NEW.provider_msg_id) THEN
    RAISE EXCEPTION 'Message identity mismatch' USING ERRCODE='23514';
  END IF;
  NEW.turn_id=saved.id;
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_assign_turn BEFORE INSERT OR UPDATE ON inbox
  FOR EACH ROW EXECUTE FUNCTION assign_inbox_turn();

CREATE TABLE tool_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), turn_id uuid NOT NULL,
  call_origin text NOT NULL CHECK(call_origin IN ('llm','fast_path','session','internal')),
  provider_call_id text CHECK(length(provider_call_id)>0),
  execution_key text NOT NULL UNIQUE CHECK(length(execution_key)>0),
  source_message_id text NOT NULL, chat_id text NOT NULL, actor_id text NOT NULL,
  tool_name text NOT NULL CHECK(length(tool_name)>0),
  risk_level text NOT NULL CHECK(risk_level IN ('read','write','destructive')),
  args_hash text NOT NULL CHECK(args_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('ok','denied','needs_confirmation','needs_clarification','not_found','queued','uncertain','error')),
  result_json jsonb NOT NULL DEFAULT '{}', parent_execution_id uuid,
  logical_action_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  CHECK(call_origin='llm' OR provider_call_id IS NULL),
  CHECK(parent_execution_id IS NULL OR parent_execution_id<>id),
  CHECK(finished_at IS NULL OR finished_at>=created_at),
  FOREIGN KEY(turn_id,chat_id,source_message_id) REFERENCES message_turns(id,resolved_chat_id,source_message_id),
  UNIQUE(chat_id,actor_id,source_message_id,tool_name,args_hash),
  UNIQUE(id,logical_action_id,chat_id,actor_id),
  FOREIGN KEY(parent_execution_id,logical_action_id,chat_id,actor_id)
    REFERENCES tool_executions(id,logical_action_id,chat_id,actor_id)
);
CREATE UNIQUE INDEX tool_execution_provider_call ON tool_executions(turn_id,provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE INDEX tool_execution_lineage ON tool_executions(logical_action_id,created_at,id);
CREATE INDEX tool_execution_parent ON tool_executions(parent_execution_id);
CREATE FUNCTION guard_tool_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent tool_executions;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.turn_id,NEW.call_origin,NEW.provider_call_id,NEW.execution_key,
        NEW.source_message_id,NEW.chat_id,NEW.actor_id,NEW.tool_name,NEW.risk_level,
        NEW.args_hash,NEW.parent_execution_id,NEW.logical_action_id,NEW.created_at) IS DISTINCT FROM
       (OLD.id,OLD.turn_id,OLD.call_origin,OLD.provider_call_id,OLD.execution_key,
        OLD.source_message_id,OLD.chat_id,OLD.actor_id,OLD.tool_name,OLD.risk_level,
        OLD.args_hash,OLD.parent_execution_id,OLD.logical_action_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Execution identity is immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.status NOT IN ('queued','uncertain') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal execution is immutable; append a continuation' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.parent_execution_id IS NOT NULL THEN
    SELECT * INTO parent FROM tool_executions WHERE id=NEW.parent_execution_id;
    IF parent.status='needs_confirmation' AND
       (NEW.turn_id=parent.turn_id OR NEW.tool_name<>parent.tool_name OR NEW.args_hash<>parent.args_hash) THEN
      RAISE EXCEPTION 'Confirmation requires a new turn with the same action' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tool_execution_guard BEFORE INSERT OR UPDATE ON tool_executions
  FOR EACH ROW EXECUTE FUNCTION guard_tool_execution();

-- Real attachment types and ownership keys from 004/007; no floating UUIDs.
ALTER TABLE media_attachments ADD CONSTRAINT media_attachment_scope UNIQUE(chat_id,owner_id,id);
ALTER TABLE school_attachments ADD CONSTRAINT school_attachment_scope UNIQUE(chat_id,owner_id,id);
CREATE TABLE chat_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL REFERENCES chats(id), actor_id text NOT NULL,
  turn_id uuid NOT NULL, source_message_id text NOT NULL,
  media_attachment_id uuid, school_attachment_id uuid,
  parent_artifact_id uuid, kind text NOT NULL, mime text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
  CHECK(num_nonnulls(media_attachment_id,school_attachment_id)=1),
  CHECK(parent_artifact_id IS NULL OR parent_artifact_id<>id),
  CHECK(expires_at>created_at),
  UNIQUE(id,chat_id,actor_id),
  FOREIGN KEY(turn_id,chat_id,source_message_id) REFERENCES message_turns(id,resolved_chat_id,source_message_id),
  FOREIGN KEY(chat_id,actor_id,media_attachment_id) REFERENCES media_attachments(chat_id,owner_id,id),
  FOREIGN KEY(chat_id,actor_id,school_attachment_id) REFERENCES school_attachments(chat_id,owner_id,id),
  FOREIGN KEY(parent_artifact_id,chat_id,actor_id) REFERENCES chat_artifacts(id,chat_id,actor_id)
);
CREATE INDEX chat_artifact_last ON chat_artifacts(chat_id,actor_id,created_at DESC,id DESC,expires_at);
CREATE INDEX chat_artifact_parent ON chat_artifacts(parent_artifact_id);
