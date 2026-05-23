-- 026_retemplate_summary_gaps.sql
-- ============================================================
-- Follow-up to migrations 024 + 025. Two business-processes
-- primitives had their SUMMARY field rewritten in PR #113 but
-- migration 024 only updated their predicate.spec. The seeded
-- summaries in prod still carry the legacy "body" / "question or
-- body" wording. Bring them in line with the templates shipped in
-- PR #113.
--
-- Sub-process primitive: the summary string in PR #113 changed
-- "via a Reference in its body" → "via a Reference in its `action`
-- field" (Action prose lives in the `action` column after migration
-- 023). 024's WHERE clause matched on the spec marker
-- `body_md cites a Reference` and only set the spec; the summary
-- was left alone.
--
-- Mutually-exclusive Decision primitive: the summary string in
-- PR #113 changed "must be explicit in the question or body" →
-- "must be explicit in the `question` or `decision`". 024's WHERE
-- clause matched on the spec marker `the question / body_md
-- explicitly marks the gateway` and only set the spec; the summary
-- was left alone.
--
-- Idempotent: the markers used here exist only in the legacy
-- wording, so re-running this migration after it has already landed
-- is a no-op.
-- ============================================================

-- Sub-process invocation (business-processes): summary "via a
-- Reference in its body" → "via a Reference in its `action` field".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb('An Action that delegates to another process should cite the sub-process by its Intent (via `intent_ids`) or via a Reference in its `action` field — never inline the sub-process''s steps here.'::text)
              ),
       summary = 'An Action that delegates to another process should cite the sub-process by its Intent (via `intent_ids`) or via a Reference in its `action` field — never inline the sub-process''s steps here.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'kind' = 'probabilistic'
   AND summary LIKE '%via a Reference in its body — never inline the sub-process''s steps%';

-- Mutually-exclusive Decision branches (business-processes):
-- summary "explicit in the question or body" → "explicit in the
-- `question` or `decision`".
UPDATE neuron_authoring_primitives
   SET data = jsonb_set(
                data,
                '{summary}',
                to_jsonb('Decision branches are mutually exclusive by default. Inclusive gateways (where multiple branches can fire together) must be explicit in the `question` or `decision` — otherwise overlapping conditions count as a wiring mistake.'::text)
              ),
       summary = 'Decision branches are mutually exclusive by default. Inclusive gateways (where multiple branches can fire together) must be explicit in the `question` or `decision` — otherwise overlapping conditions count as a wiring mistake.',
       updated_at = now()
 WHERE data->>'template_handle' = 'business-processes'
   AND data->'predicate'->>'kind' = 'probabilistic'
   AND summary LIKE '%must be explicit in the question or body%';
