-- 020_principals_doco_scoped.sql
-- ============================================================
-- Principals become Doco-scoped (no longer host-scoped).
--
-- Pre-change: the role label column was UNIQUE at the host level and
-- the optional `doco_id` lived in `data->>'doco_id'`. Two Docos that
-- both wanted a "system" role-persona had to share one row, even though
-- the two roles meant different things to the two Docos.
--
-- Post-change:
--   * `principals.doco_id` is a real column with FK → docos(id).
--   * `(doco_id, name)` is UNIQUE — each Doco gets its own
--     role-personas.
--   * Reads that previously filtered by `data->>'doco_id'` switch to
--     the typed column (one less JSON deref per row).
--
-- The role-label column name had been `username` historically but PR
-- #75 renamed it to `name` everywhere (it's a role name, not a GitHub
-- handle). schema.sql ships the new name; this migration brings any
-- pre-rename live DB in line BEFORE adding the per-Doco UNIQUE so the
-- constraint references a column that exists in both shapes.
--
-- Recovery posture: production tripped on the FK VALIDATE step on the
-- first attempt because at least one principal had a typed `doco_id`
-- that didn't match any row in `docos` (legacy data path predating the
-- typed column). The migration now scrubs invalid doco_ids back to NULL
-- before the FK validates, so the load-bearing constraints all settle
-- on a clean shape.
-- ============================================================

-- 1. Rename `username` → `name` if the legacy column is still here.
--    Migration 021 also does this, but 020 runs first and the rest of
--    this file references `name`, so we have to land the rename now.
--    Idempotent: only renames when `username` exists and `name` doesn't.
DO $rename_username_to_name$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'principals' AND column_name = 'username'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'principals' AND column_name = 'name'
  ) THEN
    ALTER TABLE principals RENAME COLUMN username TO name;
  END IF;
END
$rename_username_to_name$;

-- The host-level UNIQUE on the role label might be named after either
-- the old or new column depending on when the table was first created.
-- Drop both possible names so step 9 can land the per-Doco UNIQUE
-- without colliding.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_username_key;
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_name_key;

-- 2. Add the column (nullable initially so the backfill below has
--    somewhere to land).
ALTER TABLE principals
  ADD COLUMN IF NOT EXISTS doco_id text;

-- 3. Scrub: any pre-existing doco_id that doesn't reference a real
--    docos row goes back to NULL so the backfill below treats it like
--    a fresh row. Without this, a stale typed value would survive the
--    EXISTS gates in steps 4-6 and trip the FK VALIDATE later.
UPDATE principals p
   SET doco_id = NULL
 WHERE p.doco_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM docos d WHERE d.id = p.doco_id);

-- 4. Backfill from the legacy `data->>'doco_id'` location, only when
--    the referenced Doco actually exists.
UPDATE principals p
   SET doco_id = (p.data->>'doco_id')
 WHERE p.doco_id IS NULL
   AND p.data->>'doco_id' IS NOT NULL
   AND EXISTS (SELECT 1 FROM docos d WHERE d.id = p.data->>'doco_id');

-- 5. Backfill from referencing entities. A Principal referenced by an
--    Action / Log in some Doco belongs to that Doco — assign it. If
--    multiple Docos reference the same Principal (the cross-Doco
--    sharing the old design allowed), pick the earliest-referenced
--    Doco; the others will need to mint their own Principal post-cut,
--    but the typed FK at least gives the row one valid home.
UPDATE principals p
   SET doco_id = sub.doco_id
  FROM (
    SELECT actor_id AS principal_id, MIN(doco_id) AS doco_id
      FROM actions
     WHERE actor_id IS NOT NULL
     GROUP BY actor_id
  ) sub
 WHERE p.doco_id IS NULL
   AND p.id = sub.principal_id
   AND EXISTS (SELECT 1 FROM docos d WHERE d.id = sub.doco_id);

UPDATE principals p
   SET doco_id = sub.doco_id
  FROM (
    SELECT actor_id AS principal_id, MIN(doco_id) AS doco_id
      FROM logs
     WHERE actor_id IS NOT NULL
     GROUP BY actor_id
  ) sub
 WHERE p.doco_id IS NULL
   AND p.id = sub.principal_id
   AND EXISTS (SELECT 1 FROM docos d WHERE d.id = sub.doco_id);

-- 6. Delete unreferenced orphans — principals that still have NULL
--    doco_id AND aren't referenced by any Action/Log. The NOT EXISTS
--    gates ensure we never collide with the RESTRICT FK on
--    actions.actor_id / logs.actor_id.
DELETE FROM principals p
 WHERE p.doco_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.actor_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.actor_id = p.id);

-- 7. Last-resort fallback: any principal still NULL is referenced by an
--    Action/Log we couldn't backfill from (action.doco_id pointed at a
--    doco that no longer exists, etc.). Park it on the first surviving
--    Doco rather than abort the migration. Surfaced via NOTICE so the
--    operator can investigate post-migration.
DO $park_remaining_nulls$
DECLARE
  fallback_doco_id TEXT;
  parked_count     INT;
BEGIN
  SELECT id INTO fallback_doco_id FROM docos ORDER BY created_at LIMIT 1;
  IF fallback_doco_id IS NULL THEN
    -- No docos at all — the host is empty. Any remaining principals are
    -- unreachable. Delete them; if any are still FK-referenced, the
    -- migration aborts and a human looks at the data.
    DELETE FROM principals WHERE doco_id IS NULL;
  ELSE
    UPDATE principals SET doco_id = fallback_doco_id
     WHERE doco_id IS NULL;
    GET DIAGNOSTICS parked_count = ROW_COUNT;
    IF parked_count > 0 THEN
      RAISE NOTICE 'Migration 020 parked % principal(s) with no resolvable doco on %.',
        parked_count, fallback_doco_id;
    END IF;
  END IF;
END
$park_remaining_nulls$;

-- 8. Make doco_id NOT NULL + add the FK. After steps 3-7 every row has
--    a doco_id and it references a real docos row, so VALIDATE
--    succeeds.
ALTER TABLE principals ALTER COLUMN doco_id SET NOT NULL;

ALTER TABLE principals
  ADD CONSTRAINT principals_doco_fk
  FOREIGN KEY (doco_id) REFERENCES docos(id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE principals VALIDATE CONSTRAINT principals_doco_fk;

-- 9. Per-Doco UNIQUE. Use the post-rename name straight away so
--    migration 021's RENAME CONSTRAINT becomes a no-op (its IF EXISTS
--    guard skips when the new name is already in place).
ALTER TABLE principals
  ADD CONSTRAINT principals_doco_name_key UNIQUE (doco_id, name);

-- 10. Indexes for the new doco-scoped read patterns. Mirrors the shape
--     of every other doco-scoped neuron table.
CREATE INDEX IF NOT EXISTS principals_doco_idx
  ON principals (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS principals_lifecycle_idx
  ON principals (doco_id, lifecycle);
