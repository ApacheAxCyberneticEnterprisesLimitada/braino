-- 064_collapse_node_tables.sql — copy the 10 per-type node tables into the
-- unified `nodes` table (created by schema.sql).
--
-- Part of Proposal B (docs/plans/simplification-proposals.md): collapse the
-- per-type node sharding into one discriminated table, mirroring `edges`.
--
-- This migration is the COPY half (Stage 1). It does NOT drop the legacy
-- tables — they remain as a stale rollback snapshot until a later migration
-- (065) drops them once this is production-verified. The deeper backup is
-- node_versions (the append-only spine), which carries every node's history
-- independently.
--
-- Idempotent on the row level via ON CONFLICT (id) DO NOTHING; the whole
-- migration also runs inside one transaction (see migrations.ts), so a
-- failure rolls back cleanly and is retried on the next container.
--
-- Column mapping (legacy column -> nodes column): the per-type prose column
-- (intents.intent, decisions.decision, …) maps to nodes.prose; principals map
-- name/body_md/role_principal and leave prose = ''. Every promoted scalar/FK
-- column keeps its name. Columns a type doesn't have are NULL.
--
-- NOTE on the explicit casts: a bare NULL literal in a UNION ALL defaults to
-- `text`, which then fails to match the timestamptz columns performed_at /
-- happened_at. Each absent timestamp position is therefore NULL::timestamptz.
-- Column order below is exactly the INSERT list.
--
-- NOTE on the existence guard: the bookend runs schema.sql -> migrations ->
-- schema.sql, and the genesis reset (063) drops every table between the two
-- schema.sql passes. So on a FRESH bootstrap, neither `nodes` nor the source
-- tables exist when this runs (063 wiped them; pass 2 recreates them empty
-- AFTER migrations) — there is nothing to copy. On an already-initialised
-- database (production), 063 is skipped, pass 1 created `nodes`, and the
-- source tables hold the live rows to copy. The guard makes both paths safe.

DO $do$
BEGIN
  IF to_regclass('public.nodes') IS NULL OR to_regclass('public.intents') IS NULL THEN
    RAISE NOTICE '064: nodes/source tables absent (fresh genesis bootstrap) — nothing to copy';
    RETURN;
  END IF;

  INSERT INTO nodes (
  id, doco_id, node_type, lifecycle, prose, name, body_md, role_principal,
  parent_intent_id, proposer_id, decided_by, superseded_by_decision_id, actor_id, template_id,
  verb, performed_at, happened_at, kind, modality, severity, phase, on_violation,
  ref_type, locator, citation, title,
  data, created_at, created_by, updated_at, updated_by
)
SELECT id, doco_id, 'intent', lifecycle, intent, NULL, NULL, false,
       parent_intent_id, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM intents
UNION ALL
SELECT id, doco_id, 'idea', lifecycle, idea, NULL, NULL, false,
       NULL, proposer_id, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM ideas
UNION ALL
SELECT id, doco_id, 'rule', lifecycle, rule, NULL, NULL, false,
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, kind, modality, severity, phase, on_violation,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM rules
UNION ALL
SELECT id, doco_id, 'decision', lifecycle, decision, NULL, NULL, false,
       NULL, NULL, decided_by, superseded_by_decision_id, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM decisions
UNION ALL
SELECT id, doco_id, 'action', lifecycle, action, NULL, NULL, false,
       NULL, NULL, NULL, NULL, actor_id, NULL,
       verb, performed_at, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM actions
UNION ALL
SELECT id, doco_id, 'log', lifecycle, log, NULL, NULL, false,
       NULL, NULL, NULL, NULL, actor_id, template_id,
       verb, NULL::timestamptz, happened_at, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM logs
UNION ALL
SELECT id, doco_id, 'eval', lifecycle, eval, NULL, NULL, false,
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, kind, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM evals
UNION ALL
SELECT id, doco_id, 'state', lifecycle, state, NULL, NULL, false,
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, kind, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM states
UNION ALL
SELECT id, doco_id, 'reference', lifecycle, reference, NULL, NULL, false,
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL,
       ref_type, locator, citation, title,
       data, created_at, created_by, updated_at, updated_by
  FROM reference_entities
UNION ALL
SELECT id, doco_id, 'principal', lifecycle, '', name, body_md, role_principal,
       NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL::timestamptz, NULL::timestamptz, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       data, created_at, created_by, updated_at, updated_by
  FROM principals
  ON CONFLICT (id) DO NOTHING;
END
$do$;
