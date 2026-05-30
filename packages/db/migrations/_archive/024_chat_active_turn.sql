-- 024_chat_active_turn.sql
-- ============================================================
-- Server-side "is Señor Doco currently composing a reply?" marker.
-- Before this column, the in-flight state lived only in the client's
-- React state — a page refresh wiped it, so a user who reloaded while
-- waiting saw their own message hanging with no indication anything
-- was happening.
--
-- `active_turn_started_at` is set at the top of runAssistantTurn and
-- cleared in its finally; the snapshot endpoint returns it so a
-- fresh page load can show the "Señor Doco is replying…" placeholder
-- immediately. Indexed only on non-null rows because the lookup
-- pattern is "is anything active right now?" not historical.
--
-- Stale-row recovery: a turn that crashes the lambda before the
-- finally fires leaves the timestamp set. The client treats values
-- older than a few minutes as stale and ignores them.
-- ============================================================

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS active_turn_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_active_turn
  ON chat_conversations(active_turn_started_at)
  WHERE active_turn_started_at IS NOT NULL;
