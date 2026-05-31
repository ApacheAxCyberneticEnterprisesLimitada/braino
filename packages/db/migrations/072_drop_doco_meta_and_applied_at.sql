-- 072_drop_doco_meta_and_applied_at.sql — drop two more unused schema objects.
--
--   doco_meta                     — the schema_version table is seeded once by
--                                   schema.sql and never read; migration state
--                                   lives in applied_migrations.
--   applied_migrations.applied_at — write-only audit timestamp (DEFAULT now()):
--                                   applyMigrations() inserts `id` only and
--                                   selects `id` only, so nothing reads it.
--
-- Both are removed from the schema.sql baseline in this same change, so the
-- bootstrap's second schema.sql pass does not recreate them. IF EXISTS keeps
-- this a no-op on a fresh genesis bootstrap (where they were never created).

DROP TABLE IF EXISTS doco_meta;

ALTER TABLE applied_migrations DROP COLUMN IF EXISTS applied_at;
