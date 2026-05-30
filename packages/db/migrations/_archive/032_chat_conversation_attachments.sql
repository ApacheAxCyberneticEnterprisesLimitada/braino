-- 032_chat_conversation_attachments.sql
-- ============================================================
-- Per-thread attachments. A Señor Doco chat picks up the Docos
-- and Orgs the agent touched during the conversation — we surface
-- the list under the thread title (clickable chips) so the user
-- can jump back to whatever the chat was about.
--
-- Columns:
--   - `attached_doco_handles` — Doco handles touched in this thread,
--     populated server-side whenever the agent makes a doco_api call
--     with a per-Doco path (`/<handle>/api/...`). Append-only and
--     unique; never auto-removed.
--   - `attached_org_handles` — Org handles. Reserved for forward
--     compatibility; not auto-populated by the agent loop today
--     (orgs lack a per-org doco_api surface yet), but the schema is
--     in place so the chip rendering doesn't need to grow when we
--     wire up org-touching tool calls.
--
-- Both default to the empty array — existing rows pick that up
-- without a backfill. Storage is text[] (not a junction table)
-- because the lists are small (typically 0-3 per thread), read on
-- every snapshot, and never queried in aggregate.
-- ============================================================

ALTER TABLE chat_conversations
  ADD COLUMN IF NOT EXISTS attached_doco_handles TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS attached_org_handles TEXT[] NOT NULL DEFAULT '{}';
