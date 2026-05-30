-- Align Principal.type values across the codebase: the entity type field
-- in @doco/shared is `("person" | "agent")` and predicate filters
-- (AuthoringPredicate.allowed_principal_types) read "person", but the
-- schema CHECK was `('human','agent')` and write paths inserted "human".
-- This migration moves storage to "person" so reads and writes match.
--
-- Post-rename (migration 005): the slim Principal table no longer carries
-- a `type` column at all (OAuth identity moved to `collaborators`). On
-- post-rename DBs this migration is a no-op; the IF EXISTS guard makes
-- the upgrade boot replay safely.

DO $migration_001$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'principals' AND column_name = 'type'
  ) THEN
    ALTER TABLE principals DROP CONSTRAINT IF EXISTS principals_type_check;
    UPDATE principals SET type = 'person' WHERE type = 'human';
    ALTER TABLE principals
      ADD CONSTRAINT principals_type_check CHECK (type IN ('person', 'agent'));
  END IF;
END
$migration_001$;
