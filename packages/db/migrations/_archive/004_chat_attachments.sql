-- 004 (2026-05-21): in-page assistant attachment storage with 30-day retention.
--
-- Lets Señor Doco accept file uploads from the signed-in user (images,
-- PDFs, short text). The bytes live in this table for 30 days from
-- upload; an opportunistic purge at the top of every upload + every
-- message send deletes anything past `expires_at`.
--
-- chat_messages content blocks carry an `attachment_ref` shape that
-- points at this row by id. Once a row is gone the ref hydrates to a
-- short text placeholder so old turns still replay cleanly.

CREATE TABLE IF NOT EXISTS chat_attachments (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  principal_id     TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  content          BYTEA NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation
  ON chat_attachments(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_expires
  ON chat_attachments(expires_at);
