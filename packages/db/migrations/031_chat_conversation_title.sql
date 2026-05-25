-- 031_chat_conversation_title.sql
-- ============================================================
-- Multi-thread Señor Doco. Until now `chat_conversations` had one
-- row per principal_id (a single rolling thread per user). The new
-- UX shows a thread dropdown in the sidebar header and supports
-- per-thread chat + thinking history. Three additions:
--
--   1. `title TEXT` — user-visible thread name. Nullable; readers
--      derive a fallback from the first user message when null.
--   2. Drop the implicit "one row per collaborator" assumption in
--      `loadOrCreateConversation` — multiple rows per
--      collaborator_id are now valid.
--   3. Reuse the existing `archived BOOLEAN DEFAULT false` column
--      from migration 003 — no schema change there.
--
-- The new index keeps the "list my non-archived threads, newest
-- first" query cheap as the conversation count grows. Per-user
-- thread counts are unbounded by design; the sidebar paginates.
-- ============================================================

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS title TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_active
  ON chat_conversations(collaborator_id, updated_at DESC)
  WHERE archived = false;
