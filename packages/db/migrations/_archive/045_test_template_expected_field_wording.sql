-- 045_test_template_expected_field_wording.sql
-- ============================================================
-- Clarify that Eval `expected` is a top-level field, not nested inside
-- `criterion`. Production smoke testing showed the probabilistic judge
-- could otherwise infer the wrong API shape for exact/shape Evals.
-- ============================================================

BEGIN;

WITH replacements AS (
  SELECT
    '`exact` and `shape` criteria need a concrete `expected` value, not prose. `llm-judge` criteria put the prose property into `criterion.spec` (or `expected` when more natural) and read crisply enough that two reviewers would reach the same verdict.'::text AS old_policy,
    '`exact` and `shape` criteria need a concrete top-level Eval `expected` value, not prose. `llm-judge` criteria put the prose property into `criterion.spec` (or top-level `expected` when more natural) and read crisply enough that two reviewers would reach the same verdict.'::text AS new_policy,
    'Inspect the Eval''s `criterion.kind` and top-level `expected` field. If criterion.kind is `exact` or `shape`, the Eval''s top-level `expected` MUST be a concrete value or shape (number, string, object, array) — prose like ''the user is signed in'' FAILS. Do not require `expected` inside the `criterion` object; the API shape stores it beside `criterion`. If criterion.kind is `llm-judge`, the prose property lives in `criterion.spec` (or top-level `expected` when more natural) and reads crisply enough that two reviewers would reach the same verdict. Vague or subjective specs (`the output is good`) FAIL.'::text AS new_spec
  UNION ALL
  SELECT
    'An Eval has a recognizable test oracle: the `criterion` / `expected` pair says what evidence is observed, what it is compared against, and what counts as pass/fail.'::text AS old_policy,
    'An Eval has a recognizable test oracle: the `criterion` / top-level `expected` pair says what evidence is observed, what it is compared against, and what counts as pass/fail.'::text AS new_policy,
    'Inspect the Eval''s `criterion` and top-level `expected` field. PASS when the oracle is recognizable: it names the actual evidence to observe, the expected value or property to compare against, and the pass/fail boundary. For `exact` and `shape`, a concrete top-level `expected` value can carry the oracle if it is clear what `actual` is compared to. For `llm-judge`, `criterion.spec` must name the evidence and the decision boundary. FAIL vague or circular criteria like `works`, `matches requirements`, `is good`, or restatements of the Eval label without observable evidence.'::text AS new_spec
)
UPDATE neuron_authoring_policies p
   SET policy = r.new_policy,
       data = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    p.data,
                    '{policy}',
                    to_jsonb(r.new_policy),
                    true
                  ),
                  '{summary}',
                  to_jsonb(r.new_policy),
                  true
                ),
                '{predicate,spec}',
                to_jsonb(r.new_spec),
                true
              ),
       updated_at = now()
  FROM replacements r
 WHERE p.data->>'template_handle' = 'test'
   AND p.policy = r.old_policy;

COMMIT;
