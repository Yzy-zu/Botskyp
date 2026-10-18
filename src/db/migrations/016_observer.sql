-- Temporary owner-local forensic recorder. No FK to business transactions.
CREATE TABLE observer_events (
 id bigserial PRIMARY KEY, event_id uuid NOT NULL UNIQUE, turn_id text,
 chat_id text, actor_id text, provider_msg_id text, event_type text NOT NULL,
 stage text NOT NULL, sequence text NOT NULL, created_at timestamptz NOT NULL,
 payload jsonb NOT NULL, process_instance text NOT NULL, git_commit text NOT NULL,
 correlation jsonb NOT NULL
);
CREATE INDEX observer_turn_sequence ON observer_events(turn_id,sequence,event_id);
CREATE INDEX observer_chat_time ON observer_events(chat_id,created_at);
CREATE INDEX observer_actor_time ON observer_events(actor_id,created_at);
CREATE INDEX observer_type_time ON observer_events(event_type,created_at);
CREATE INDEX observer_provider ON observer_events(provider_msg_id);
CREATE INDEX observer_retention ON observer_events(created_at);
CREATE VIEW observer_turns AS
SELECT turn_id,
 (array_agg(chat_id ORDER BY sequence DESC) FILTER(WHERE chat_id IS NOT NULL))[1] chat,
 (array_agg(actor_id ORDER BY sequence DESC) FILTER(WHERE actor_id IS NOT NULL))[1] actor,
 (array_agg(payload->>'userText' ORDER BY sequence) FILTER(WHERE event_type='INBOUND_NORMALIZED'))[1] user_text,
 min(created_at) started_at,
 max(created_at) FILTER(WHERE event_type IN ('TURN_COMPLETED','TURN_FAILED','OUTBOX_SENT','OUTBOX_FAILED')) finished_at,
 extract(epoch FROM max(created_at)-min(created_at))*1000 duration_ms,
 count(*) FILTER(WHERE event_type='LLM_REQUEST') llm_calls,
 array_agg(payload->>'toolName' ORDER BY sequence) FILTER(WHERE event_type='TOOL_PROPOSED') tools,
 (array_agg(coalesce(payload->>'status',event_type) ORDER BY sequence DESC) FILTER(WHERE event_type IN ('TURN_COMPLETED','TURN_FAILED','OUTBOX_SENT','OUTBOX_FAILED'))) [1] final_status,
 (array_agg(payload->>'finalReply' ORDER BY sequence DESC) FILTER(WHERE payload ? 'finalReply'))[1] final_reply,
 count(*) FILTER(WHERE event_type IN ('LLM_ERROR','LLM_ATTEMPT_ERROR','TOOL_ERROR','JOB_FAILED','OUTBOX_FAILED','TURN_FAILED','TRANSACTION_ROLLBACK')) error_count
FROM observer_events WHERE turn_id IS NOT NULL GROUP BY turn_id;
