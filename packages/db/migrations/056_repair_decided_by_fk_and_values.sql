-- 056_repair_decided_by_fk_and_values.sql
-- ============================================================
-- Repairs damage an earlier revision of migration 055 did to
-- decisions.decided_by on databases that already applied it (prod).
--
-- decided_by holds a principal_<ulid> (a Principal neuron), NOT an
-- OAuth identity. Migration 013 originally FK'd it to collaborators(id);
-- migration 025 dropped that FK precisely because the column moved to
-- principal ids (PR #66 made the capture API require them).
--
-- The first 055 revision wrongly (a) re-added the FK as
-- decisions_decided_by_fk → users(id) and (b) nulled every decided_by
-- value that wasn't user_-shaped — destroying the principal references
-- in the column. The canonical value survives in the row's `data` jsonb
-- (decisions persist decided_by into both the typed column and the
-- denormalized data bag), so we can restore it.
--
-- This migration:
--   1. Drops the bogus FK (no-op on a DB that already has corrected 055).
--   2. Restores decided_by from data->>'decided_by' wherever the column
--      was nulled but the jsonb still carries the value.
--
-- Idempotent: DROP IF EXISTS, and the restore only touches NULL columns.
-- ideas.proposer_id is intentionally untouched — its FK to users(id) is
-- legitimate (it always held an OAuth identity), so 055 keeps it.
-- ============================================================

ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_decided_by_fk;

UPDATE decisions
   SET decided_by = data->>'decided_by'
 WHERE decided_by IS NULL
   AND COALESCE(data->>'decided_by', '') <> '';
