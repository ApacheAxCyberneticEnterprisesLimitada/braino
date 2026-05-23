-- 017_rename_doco_goal_description_to_goal.sql
-- ============================================================
-- The Doco "goal description" field is now just "goal". The 2026-05-23
-- iteration on the wording dropped "description" from both the column
-- name and the UI label. Idempotent rename — guarded so reruns and
-- fresh installs (where schema.sql already creates the column under
-- the new name) both no-op.
-- ============================================================

DO $rename_doco_goal_description$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'docos' AND column_name = 'goal_description'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'docos' AND column_name = 'goal'
  ) THEN
    ALTER TABLE docos RENAME COLUMN goal_description TO goal;
  END IF;
END
$rename_doco_goal_description$;
