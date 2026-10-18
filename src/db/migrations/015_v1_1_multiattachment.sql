-- Preserve every original; extend identity to the authenticated attachment ordinal.
ALTER TABLE media_attachments DROP CONSTRAINT media_attachments_chat_id_owner_id_source_message_id_is_ori_key;
ALTER TABLE media_attachments ADD CONSTRAINT media_original_ordinal UNIQUE(chat_id,owner_id,source_message_id,artifact_index,is_original);
-- Backing IDs already have independent uniqueness. Message/kind collapses same-kind siblings.
DROP INDEX artifact_incoming_once;
ALTER TABLE chat_artifacts ADD COLUMN source_attachment_index int NOT NULL DEFAULT 0 CHECK(source_attachment_index>=0);
UPDATE chat_artifacts a SET source_attachment_index=m.artifact_index FROM media_attachments m WHERE m.id=a.media_attachment_id AND a.origin='user_input';
CREATE UNIQUE INDEX artifact_incoming_ordinal ON chat_artifacts(chat_id,actor_id,source_message_id,source_attachment_index) WHERE origin='user_input';
