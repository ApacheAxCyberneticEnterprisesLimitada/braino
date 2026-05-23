-- 016_doco_goal_description.sql
-- ============================================================
-- Docos get a `goal_description` text column — a free-form sentence or
-- paragraph the project owner writes (or the template seeds) to tell
-- agents at bootstrap what this Doco is for. Surfaced at the top of
-- each Doco's primitive set in the agent-bootstrap manifest, and
-- under the title on the Doco home page.
--
-- NOT NULL DEFAULT '' so existing rows backfill to empty (no-template
-- Docos and pre-existing Docos have nothing to show until edited).
-- ============================================================

ALTER TABLE docos
  ADD COLUMN IF NOT EXISTS goal_description text NOT NULL DEFAULT '';
