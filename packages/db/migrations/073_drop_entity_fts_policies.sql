-- 073_drop_entity_fts_policies.sql — drop the write-only policy FTS table.
--
-- entity_fts_policies was populated by the indexer on every capture, but
-- nothing ever queried it: the only full-text-search reader is Slack search
-- (packages/web/app/lib/slack.server.ts), which hits entity_fts_nodes only.
-- The policy-FTS write path is removed from packages/db/src/indexer.ts in this
-- same change, so the table has no writer either. (Migrations 071/072 dropped
-- the other unused FTS / bookkeeping objects; this finishes the set.)
--
-- The matching CREATE block is removed from schema.sql in this change, so the
-- bootstrap's second schema.sql pass does not recreate it. IF EXISTS keeps this
-- a no-op on a fresh genesis bootstrap. No external FK references the table.

DROP TABLE IF EXISTS entity_fts_policies CASCADE;
