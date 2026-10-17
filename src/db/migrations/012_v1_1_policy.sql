-- Separate from legacy foreground sessions: no v1 behavior changes.
CREATE TABLE tool_confirmations_v2 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL UNIQUE,
  logical_action_id uuid NOT NULL, chat_id text NOT NULL, actor_id text NOT NULL,
  tool_name text NOT NULL, args_hash text NOT NULL CHECK(args_hash ~ '^[a-f0-9]{64}$'),
  resolved_args jsonb NOT NULL, scope_state jsonb NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_execution_id uuid UNIQUE REFERENCES tool_executions(id),
  invalidated boolean NOT NULL DEFAULT false,
  FOREIGN KEY(execution_id,logical_action_id,chat_id,actor_id)
    REFERENCES tool_executions(id,logical_action_id,chat_id,actor_id)
);
ALTER TABLE tool_executions ADD COLUMN request_hash text CHECK(request_hash ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX tool_execution_request ON tool_executions(turn_id,chat_id,actor_id,tool_name,request_hash)
  WHERE request_hash IS NOT NULL;
CREATE UNIQUE INDEX tool_execution_confirmed_action ON tool_executions(logical_action_id,chat_id,actor_id)
  WHERE parent_execution_id IS NOT NULL AND status IN ('ok','queued','uncertain');
CREATE FUNCTION guard_tool_request_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'Execution request identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tool_request_identity_guard BEFORE UPDATE ON tool_executions
  FOR EACH ROW EXECUTE FUNCTION guard_tool_request_identity();
