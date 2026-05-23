-- 020_principals_doco_scoped.sql
-- ============================================================
-- Principals become Doco-scoped (no longer host-scoped).
--
-- Pre-change: `principals.username` was UNIQUE at the host level and
-- the optional `doco_id` lived in `data->>'doco_id'`. Two Docos that
-- both wanted a "system" role-persona had to share one row, even though
-- the two roles meant different things to the two Docos.
--
-- Post-change:
--   * `principals.doco_id` is a real column with FK → docos(id).
--   * `(doco_id, username)` is UNIQUE — each Doco gets its own
--     role-personas.
--   * Reads that previously filtered by `data->>'doco_id'` switch to
--     the typed column (one less JSON deref per row).
-- ============================================================

-- 1. Add the column (nullable initially so the backfill below has
--    somewhere to land).
ALTER TABLE principals
  ADD COLUMN IF NOT EXISTS doco_id text;

-- 2. Backfill from the legacy `data->>'doco_id'` location, only when
--    the referenced Doco actually exists (so the FK validation below
--    holds on every populated row).
UPDATE principals p
   SET doco_id = (p.data->>'doco_id')
 WHERE p.doco_id IS NULL
   AND p.data->>'doco_id' IS NOT NULL
   AND EXISTS (SELECT 1 FROM docos d WHERE d.id = p.data->>'doco_id');

-- 3. Backfill from referencing entities. A Principal referenced by an
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

-- 4. Delete principals that are still doco-less after the backfill.
--    These are bootstrap_placeholder rows from ADR-073 (per the comment
--    in `listPrincipals`) plus any other orphans. They aren't referenced
--    by actions/logs (those are RESTRICT FKs, so referenced rows can't
--    be deleted anyway — the RESTRICT will surface if I'm wrong here).
DELETE FROM principals WHERE doco_id IS NULL;

-- 5. Make doco_id NOT NULL + add the FK. NOT VALID + VALIDATE so the
--    initial constraint check doesn't take an ACCESS EXCLUSIVE lock on
--    a hot table (matches the pattern in 013_promote_scalar_id_refs).
ALTER TABLE principals ALTER COLUMN doco_id SET NOT NULL;

ALTER TABLE principals
  ADD CONSTRAINT principals_doco_fk
  FOREIGN KEY (doco_id) REFERENCES docos(id) ON DELETE CASCADE
  NOT VALID;
ALTER TABLE principals VALIDATE CONSTRAINT principals_doco_fk;

-- 6. Replace host-level UNIQUE(username) with per-Doco UNIQUE.
ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_username_key;

ALTER TABLE principals
  ADD CONSTRAINT principals_doco_username_key UNIQUE (doco_id, username);

-- 7. Indexes for the new doco-scoped read patterns. Mirrors the shape
--    of every other doco-scoped neuron table.
CREATE INDEX IF NOT EXISTS principals_doco_idx
  ON principals (doco_id, created_at DESC);
CREATE INDEX IF NOT EXISTS principals_lifecycle_idx
  ON principals (doco_id, lifecycle);
