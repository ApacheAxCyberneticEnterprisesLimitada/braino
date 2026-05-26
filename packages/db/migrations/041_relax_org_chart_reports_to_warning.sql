-- 041_relax_org_chart_reports_to_warning.sql
-- ============================================================
-- The org-chart template originally modeled "every active Principal
-- should report to someone" as a deterministic requires_synapse
-- warning, with a separate probabilistic warning for valid top-of-
-- chain Principals. That meant a legitimate CEO/founder/root-agent
-- Principal still received an unavoidable missing-reports_to warning
-- even when body_md explained the root.
--
-- Retire the deterministic warning and make the probabilistic policy
-- carry the real rule: an active Principal either has reports_to or
-- explains why it is top-of-chain.
-- ============================================================

BEGIN;

UPDATE neuron_authoring_policies
   SET lifecycle = 'retired',
       data = jsonb_set(data, '{lifecycle}', '"retired"'::jsonb, true),
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND data->'predicate'->>'kind' = 'requires_synapse'
   AND data->'predicate'->>'synapse_type' = 'reports_to'
   AND data->'predicate'->'when_neuron_type' = '["principal"]'::jsonb
   AND COALESCE(lifecycle, 'active') <> 'retired';

UPDATE neuron_authoring_policies
   SET policy = 'Every active Principal in an org chart either declares `reports_to` (the Principal they report to) or explains in `body_md` why it is top-of-chain (founder, board-reporting, root agent, external authority).',
       data = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      data,
                      '{policy}',
                      to_jsonb(
                        'Every active Principal in an org chart either declares `reports_to` (the Principal they report to) or explains in `body_md` why it is top-of-chain (founder, board-reporting, root agent, external authority).'::text
                      ),
                      true
                    ),
                    '{summary}',
                    to_jsonb(
                      'Every active Principal in an org chart either declares `reports_to` (the Principal they report to) or explains in `body_md` why it is top-of-chain (founder, board-reporting, root agent, external authority).'::text
                    ),
                    true
                  ),
                  '{predicate,spec}',
                  to_jsonb(
                    'Read the Principal candidate. PASS if `reports_to` is a non-empty Principal id. Otherwise, PASS only if `body_md` explains why this Principal has no manager above it (founder, board-reporting, root agent, external authority, etc.). FAIL with reason when an active Principal has no `reports_to` and `body_md` does not explain the missing reporting edge.'::text
                  ),
                  true
                ),
                '{fires_when_neuron_lifecycle}',
                '["active"]'::jsonb,
                true
              ),
       updated_at = now()
 WHERE data->>'template_handle' = 'org-chart'
   AND data->'predicate'->>'kind' = 'probabilistic'
   AND data->'predicate'->'when_neuron_type' = '["principal"]'::jsonb
   AND data->'predicate'->>'spec' LIKE '%top of a reporting chain%'
   AND COALESCE(lifecycle, 'active') = 'active';

COMMIT;
