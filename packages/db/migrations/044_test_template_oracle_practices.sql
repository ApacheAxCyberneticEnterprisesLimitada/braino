-- 044_test_template_oracle_practices.sql
-- ============================================================
-- Add recognizable test-oracle expectations and familiar testing
-- practice guidance to existing Docos seeded from the test template.
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
      upper(substring(md5(doco_id || ':test:recognizable-test-oracle'), 1, 26)) AS id,
    created_by,
    'An Eval has a recognizable test oracle: the `criterion` / `expected` pair says what evidence is observed, what it is compared against, and what counts as pass/fail.' AS policy,
    'Inspect the Eval''s `criterion` and `expected`. PASS when the oracle is recognizable: it names the actual evidence to observe, the expected value or property to compare against, and the pass/fail boundary. For `exact` and `shape`, a concrete `expected` value can carry the oracle if it is clear what `actual` is compared to. For `llm-judge`, `criterion.spec` must name the evidence and the decision boundary. FAIL vague or circular criteria like `works`, `matches requirements`, `is good`, or restatements of the Eval label without observable evidence.' AS spec
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
      'smallest-effective-check',
      'Treat this as a test-pyramid rule: prefer the smallest effective check. Use a unit or integration Eval when deterministic behavior answers the question; reserve process, doc-consistency, and `llm-judge` Evals for behavior that cannot be recognized by a smaller structural or executable test.'
    ),
    (
      'bdd-aaa-phrasing',
      'Given/When/Then or Arrange/Act/Assert phrasing is welcome when it clarifies setup, action, and expectation, but keep one behavior per Eval.'
    ),
    (
      'flaky-eval-handling',
      'A flaky Eval is not green. Record every outcome as a Log, stabilize the runner/data/environment before relying on it, or retire the Eval with a Decision that explains why the signal is no longer useful.'
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
