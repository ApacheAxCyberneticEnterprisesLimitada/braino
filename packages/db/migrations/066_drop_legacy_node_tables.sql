-- 066_drop_legacy_node_tables.sql — Stage 2 of Proposal B: drop the 10 legacy
-- per-type node tables now that the unified `nodes` table is the live store.
--
-- Stage 1b (migrations 064 copy + 065 re-sync, PRs #659/#660) moved every read
-- and write onto `nodes`; the per-type tables have been unread/unwritten since
-- and were retained only as a rollback snapshot. `node_versions` remains the
-- independent append-only history spine. The matching CREATE TABLE blocks are
-- removed from schema.sql in this same change, so the bootstrap bookend's
-- second schema.sql pass does not recreate them.
--
-- Safe to CASCADE: every inbound FK to these tables came from another of these
-- tables (verified — zero external references), so they all drop together.
-- IF EXISTS makes it a no-op on a fresh genesis bootstrap (the tables were
-- never created there — schema.sql no longer defines them).

DROP TABLE IF EXISTS
  intents,
  decisions,
  rules,
  actions,
  logs,
  evals,
  states,
  ideas,
  reference_entities,
  principals
CASCADE;
