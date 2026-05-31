-- 071_drop_dead_tables.sql — drop tables and a column with no read or write
-- path anywhere in the codebase.
--
-- Verified dead (zero SQL / CRUD references):
--   tags                       — dormant "auxiliary entity"; never created,
--                                read, or written by any code path.
--   entity_fts_users           — the indexer only populates entity_fts_nodes
--   entity_fts_docos             and entity_fts_policies; the users / docos /
--   entity_fts_organizations     organizations FTS tables were created but
--                                never filled or queried.
--   doco_templates             — templates are code-defined (DEFAULT_DOCO_
--                                TEMPLATES); the table is never touched.
--   perspectives.owner_user_id — unwired post-055 vestige; `owner_handle` is
--                                the live owner ref.
--
-- The matching CREATE TABLE blocks / column are removed from schema.sql in
-- this same change, so the bootstrap's second schema.sql pass does not
-- recreate them. IF EXISTS keeps this a no-op on a fresh genesis bootstrap
-- (where the objects were never created). No external FK references these
-- tables, so the drops are independent.

DROP TABLE IF EXISTS
  tags,
  entity_fts_users,
  entity_fts_docos,
  entity_fts_organizations,
  doco_templates
CASCADE;

ALTER TABLE perspectives DROP COLUMN IF EXISTS owner_user_id;
