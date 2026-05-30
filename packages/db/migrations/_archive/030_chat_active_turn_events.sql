-- 030_chat_active_turn_events.sql
-- ============================================================
-- Resumable thinking column. Before this column, the per-turn
-- ThinkingEvent stream lived only in the client's React state.
-- A page refresh while a turn was in flight dropped every event
-- already accumulated; the Thinking column showed "0 events,
-- waiting for first event…" even though the lambda was happily
-- still producing tool calls and tokens.
--
-- Persist the events server-side as the turn streams. Cleared on
-- turn end. Snapshot endpoint returns the array so a freshly-
-- loaded tab can re-hydrate the Thinking column for whatever's
-- already happened on the still-running turn.
--
-- JSONB array is appended with `jsonb_set` / `||`; per-event
-- size is small (~100-500 bytes) so even a 50-event turn stays
-- under a kilobyte. The column resets to '[]' on every new turn.
-- ============================================================

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS active_turn_events JSONB NOT NULL DEFAULT '[]'::jsonb;
