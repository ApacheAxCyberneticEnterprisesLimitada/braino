-- 042_test_template_reproducible_runs.sql
-- ============================================================
-- The test template already required active Evals to carry
-- `how_to_run`, but a non-empty string can still be too vague to
-- reproduce. Add the new probabilistic quality gate and companion
-- guidance to existing Docos seeded from the test template.
--
-- Idempotent: policy ids are deterministic per Doco and each insert
-- also checks for the exact policy text before adding a row.
-- ============================================================

BEGIN;

WITH test_docos AS (
  SELECT doco_id, min(created_by) AS created_by
    FROM (
      SELECT doco_id, created_by
        FROM neuron_authoring_policies
       WHERE data->>'template_handle' = 'test'
      UNION ALL
      SELECT doco_id, created_by
        FROM guidance_policies
       WHERE data->>'template_handle' = 'test'
    ) seeded
   GROUP BY doco_id
),
new_policy AS (
  SELECT
    doco_id,
    'neuron_authoring_policy_' ||
      upper(substring(md5(doco_id || ':test:reproducible-how-to-run'), 1, 26)) AS id,
    created_by,
    'An active Eval''s `how_to_run` is reproducible without hidden context: it names the command, prompt, URL, or manual procedure plus any required fixture or environment.' AS policy,
    'Check the Eval''s `how_to_run` field. PASS when it gives a concrete rerun path: an exact command, prompt, URL, or manual procedure, plus any required fixture, input, account, environment, or setup needed to produce `actual`. FAIL when it is vague (`run the tests`, `ask the agent`, `manual QA`) or depends on unstated context.' AS spec
    FROM test_docos
)
INSERT INTO neuron_authoring_policies
  (id, doco_id, policy, lifecycle, body_md, data, created_at, created_by, updated_at, updated_by)
SELECT
  p.id,
  p.doco_id,
  p.policy,
  'active',
  '',
  jsonb_build_object(
    'id', p.id,
    'doco_id', p.doco_id,
    'policy_kind', 'neuron_authoring',
    'policy', p.policy,
    'summary', p.policy,
    'evaluation_kind', 'probabilistic',
    'predicate', jsonb_build_object(
      'kind', 'probabilistic',
      'when_neuron_type', jsonb_build_array('eval'),
      'spec', p.spec
    ),
    'on_violation', 'block',
    'fires_when_neuron_lifecycle', jsonb_build_array('active'),
    'template_seeded', true,
    'template_handle', 'test',
    'created_at', now(),
    'created_by', p.created_by,
    'lifecycle', 'active'
  ),
  now(),
  p.created_by,
  now(),
  p.created_by
FROM new_policy p
WHERE NOT EXISTS (
  SELECT 1
    FROM neuron_authoring_policies existing
   WHERE existing.doco_id = p.doco_id
     AND existing.data->>'template_handle' = 'test'
     AND existing.policy = p.policy
)
ON CONFLICT (id) DO NOTHING;

WITH test_docos AS (
  SELECT doco_id, min(created_by) AS created_by
    FROM (
      SELECT doco_id, created_by
        FROM neuron_authoring_policies
       WHERE data->>'template_handle' = 'test'
      UNION ALL
      SELECT doco_id, created_by
        FROM guidance_policies
       WHERE data->>'template_handle' = 'test'
    ) seeded
   GROUP BY doco_id
),
new_guidance(slug, policy) AS (
  VALUES
    (
      'repo-native-tests',
      'When a repo-native automated test exists or can reasonably exist, the Eval''s `how_to_run` points at that command or file. The Doco Eval is the durable claim and audit trail, not a replacement for executable test code.'
    ),
    (
      'inline-fixture-size',
      'Large fixtures, golden files, screenshots, and transcripts live as References or repo artifacts. Keep Eval `input`, `expected`, and `actual` small enough to review inline.'
    ),
    (
      'deterministic-criteria-first',
      '`exact` and `shape` are preferred for deterministic checks; reserve `llm-judge` for semantic behavior, process traces, and documentation consistency where a structural comparison would hide the real question.'
    )
),
new_rows AS (
  SELECT
    d.doco_id,
    'guidance_policy_' ||
      upper(substring(md5(d.doco_id || ':test:' || g.slug), 1, 26)) AS id,
    d.created_by,
    g.policy
    FROM test_docos d
   CROSS JOIN new_guidance g
)
INSERT INTO guidance_policies
  (id, doco_id, policy, lifecycle, body_md, data, created_at, created_by, updated_at, updated_by)
SELECT
  r.id,
  r.doco_id,
  r.policy,
  'active',
  '',
  jsonb_build_object(
    'id', r.id,
    'doco_id', r.doco_id,
    'policy_kind', 'guidance',
    'policy', r.policy,
    'summary', r.policy,
    'template_seeded', true,
    'template_handle', 'test',
    'created_at', now(),
    'created_by', r.created_by,
    'lifecycle', 'active'
  ),
  now(),
  r.created_by,
  now(),
  r.created_by
FROM new_rows r
WHERE NOT EXISTS (
  SELECT 1
    FROM guidance_policies existing
   WHERE existing.doco_id = r.doco_id
     AND existing.data->>'template_handle' = 'test'
     AND existing.policy = r.policy
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
