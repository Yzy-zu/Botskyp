-- Persistence of exact Gemini model arguments and Policy evaluation per tool execution,
-- plus support for QA suppressed terminal execution status.
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS input_args jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS policy_decision text;
ALTER TABLE tool_executions ADD COLUMN IF NOT EXISTS policy_code text;

ALTER TABLE tool_executions DROP CONSTRAINT IF EXISTS tool_executions_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_status_check
  CHECK(status IN ('ok','denied','needs_confirmation','needs_clarification','not_found','queued','uncertain','error','qa_suppressed'));
