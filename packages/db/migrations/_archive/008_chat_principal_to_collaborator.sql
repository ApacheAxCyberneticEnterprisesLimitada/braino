-- 008 (2026-05-22): rename chat tables' `principal_id` → `collaborator_id`
--
-- The vocabulary sweep (005_neurons_synapses_primitives_collaborators.sql,
-- and a follow-up code rename) renamed `principal_id` → `collaborator_id`
-- across the app's TypeScript surface, but missed the two chat tables
-- added later (003_chat.sql + 004_chat_attachments.sql). Result: the
-- conversation loader and every assistant POST 500s with "column
-- collaborator_id does not exist".
--
-- The FK target (`principals(id)`) is unchanged — `principals` remains
-- the canonical identity table. Only the foreign-key column on the
-- chat tables is renamed to match the new vocabulary.
--
-- Idempotent via IF EXISTS so a fresh DB created from this migration
-- onward (which won't have the old column) is a no-op.

ALTER TABLE chat_conversations RENAME COLUMN principal_id TO collaborator_id;
ALTER INDEX  idx_chat_conversations_principal_active RENAME TO idx_chat_conversations_collaborator_active;

ALTER TABLE chat_attachments  RENAME COLUMN principal_id TO collaborator_id;
