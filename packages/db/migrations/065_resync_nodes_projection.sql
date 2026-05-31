-- 065_resync_nodes_projection.sql — rebuild the unified `nodes` projection
-- from the per-type tables at the Stage 1b cutover.
--
-- Why this exists: migration 064 (Stage 1a) populated `nodes` as an additive
-- copy, but `nodes` was UNUSED until Stage 1b — meanwhile the app kept writing
-- the per-type tables, so 064's copy went stale. Stage 1b flips reads+writes
-- onto `nodes`; this migration runs in the same deploy's bootstrap bookend
-- (before the new code serves a request) and rebuilds `nodes` so it exactly
-- matches the per-type tables at the moment of cutover. After this, the
-- per-type tables are stale (no longer written) until Stage 2 drops them.
--
-- Idempotent + bootstrap-safe via the same existence guard as 064: copies on
-- an initialised database (production), no-ops during the genesis-reset window
-- on a fresh bootstrap. TRUNCATE is safe here — `nodes` holds only 064's stale
-- copy at this point (the new code hasn't written it yet, migrations run before
-- serving), and the per-type tables are the live source. node_versions remains
-- the independent backup.
--
-- Column map is identical to 064; see that file for the casts/NULL notes.

DO $do$
BEGIN
  IF to_regclass('public.nodes') IS NULL OR to_regclass('public.intents') IS NULL THEN
    RAISE NOTICE '065: nodes/source tables absent (fresh genesis bootstrap) — nothing to resync';
    RETURN;
  END IF;

  TRUNCATE TABLE nodes;

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
    FROM principals;
END
$do$;
