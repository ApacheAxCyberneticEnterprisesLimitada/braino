-- 038_policy_rename_summary_to_policy.sql
-- ============================================================
-- Match the migration-023 type-named-prose pattern on the two
-- policy tables. The 9 migrated neuron types (intent, decision,
-- rule, action, log, eval, state, idea, reference) collapsed
-- summary + body_md + title into a single type-named prose column
-- in migration 023. Policies still carry `summary` + `body_md`;
-- per "in policy, the name summary should be renamed policy", do
-- the rename now so the surface matches every other neuron-shaped
-- entity in the schema.
--
-- We rename `summary` → `policy` on both policy tables (one-line
-- rule statement) and leave `body_md` (long-form rationale / "why")
-- intact. The 9 neuron types collapsed *both* prose surfaces into
-- one, but for policies the two carry different things — the
-- summary is the rule, body_md is the explanation — so we keep
-- body_md as a separate optional column.

BEGIN;

ALTER TABLE guidance_policies         RENAME COLUMN summary TO policy;
ALTER TABLE neuron_authoring_policies RENAME COLUMN summary TO policy;

-- Keep the denormalized FTS table in sync. Postgres won't rename
-- a column that a STORED GENERATED column expression depends on, so
-- drop the search_tsv first, rename, then re-create it with the
-- new column name. The indexer rebuilds the rows on every neuron
-- change so the data round-trips through naturally after this.
ALTER TABLE entity_fts_policies DROP COLUMN IF EXISTS search_tsv;
ALTER TABLE entity_fts_policies RENAME COLUMN summary TO policy;
ALTER TABLE entity_fts_policies
  ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(policy, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS entity_fts_policies_tsv_idx
  ON entity_fts_policies USING gin (search_tsv);

COMMIT;
