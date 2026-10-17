-- R5: provider accounting belongs to a durable logical turn, never freeform prompt history.
ALTER TABLE llm_usage ADD COLUMN turn_id uuid REFERENCES message_turns(id);
CREATE INDEX llm_usage_turn ON llm_usage(turn_id) WHERE turn_id IS NOT NULL;
