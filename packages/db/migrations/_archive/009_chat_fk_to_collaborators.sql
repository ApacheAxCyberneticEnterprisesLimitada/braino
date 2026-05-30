-- 009 (2026-05-22): point chat-table FKs at `collaborators(id)`.
--
-- Migration 008 renamed the column on chat_conversations / chat_attachments
-- from `principal_id` to `collaborator_id`, but the FOREIGN KEY itself
-- still pointed at `principals(id)`. After the vocab sweep (005),
-- `principals` no longer holds OAuth identities — those moved to a new
-- `collaborators` table. Real users now have `collaborator_*` ids,
-- which fail the principals(id) FK check, so every conversation
-- INSERT on prod 500s with:
--   "Key (collaborator_id)=(collaborator_01K…) is not present in
--    table 'principals'."
--
-- This migration drops the stale FK, deletes any rows that reference
-- ids missing from `collaborators` (legacy `principal_*` chat rows
-- created before the split — they no longer have an owner since
-- OAuth identities moved tables), and re-adds the FK pointing at the
-- right table.
--
-- ON DELETE CASCADE retained — when a collaborator's identity is
-- removed, their chat history goes with them.

ALTER TABLE chat_conversations
  DROP CONSTRAINT IF EXISTS chat_conversations_principal_id_fkey;

ALTER TABLE chat_attachments
  DROP CONSTRAINT IF EXISTS chat_attachments_principal_id_fkey;

-- Defensive: drop any chat rows whose collaborator_id isn't a known
-- collaborator. Attachments cascade off conversations, so deleting
-- conversations cleans them up too.
DELETE FROM chat_conversations
 WHERE collaborator_id NOT IN (SELECT id FROM collaborators);

DELETE FROM chat_attachments
 WHERE collaborator_id NOT IN (SELECT id FROM collaborators);

ALTER TABLE chat_conversations
  ADD CONSTRAINT chat_conversations_collaborator_id_fkey
  FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;

ALTER TABLE chat_attachments
  ADD CONSTRAINT chat_attachments_collaborator_id_fkey
  FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE;
