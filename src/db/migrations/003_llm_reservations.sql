-- Preserve the conservative reservation used before per-request accounting existed.
ALTER TABLE llm_usage ADD COLUMN reserved_input_tokens int NOT NULL DEFAULT 32768 CHECK(reserved_input_tokens>=0);
