-- 003 (2026-05-21): in-page assistant chat persistence.
--
-- Two tables back the persistent left-rail assistant. One rolling
-- conversation per signed-in Principal — the sidebar always re-opens
-- to the most recently touched thread; a "New chat" action marks the
-- current one archived and starts a fresh row.
--
-- chat_messages stores Anthropic-API-shaped content blocks as JSONB so
-- assistant turns that include tool_use / tool_result can be replayed
-- and re-fed to the model without lossy reconstruction.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id               TEXT PRIMARY KEY,
  principal_id     TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  archived         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_principal_active
  ON chat_conversations(principal_id, updated_at DESC)
  WHERE archived = false;

CREATE TABLE IF NOT EXISTS chat_messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
  ON chat_messages(conversation_id, created_at);
