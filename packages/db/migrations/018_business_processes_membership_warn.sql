-- 018_business_processes_membership_warn.sql
-- ============================================================
-- The `business-processes` template ships a membership primitive that
-- previously blocked captures whose prose didn't read as a "repeatable
-- business process". That semantic gate was too restrictive (legitimate
-- personal / operational workflows got rejected, and the author had
-- already opted into the template by installing it). PR #63 softened
-- the template:
--   - on_violation: warn  (was: block)
--   - prose: workflow with steps/actors/outcome, can be commercial,
--     operational, or personal  (was: "repeatable business process")
--
-- PR #63 only updated the template definition — existing Docos still
-- carry the old primitive seeded into their `neuron_authoring_primitives`
-- rows. This migration rewrites those rows so the soft version is
-- live everywhere, not only for newly-created Docos.
--
-- Targeted update: rows whose `data->>'template_handle' = 'business-processes'`
-- AND whose stored summary matches the legacy "repeatable business
-- process" wording. Other primitives on the business-processes
-- template (structural rules like `requires_field` on actor_id) stay
-- untouched.
-- ============================================================

-- Guard on legacy table name. On a fresh post-024 schema the
-- replacement table is `neuron_authoring_policies`, and any matching
-- rows have already been re-summarised at write time, so this is a
-- no-op there.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_primitives') THEN
    UPDATE neuron_authoring_primitives
       SET data = jsonb_set(
                    jsonb_set(
                      jsonb_set(
                        data,
                        '{on_violation}',
                        '"warn"'::jsonb
                      ),
                      '{summary}',
                      to_jsonb(
                        'A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. One-off incidents, UI-specific user journeys, and pure state machines without a workflow outcome belong elsewhere.'::text
                      )
                    ),
                    '{predicate,spec}',
                    to_jsonb(
                      'A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. Pass when the candidate describes a step, gateway, milestone, validation, reference, or policy for such a workflow. Fail only when the candidate is a one-off incident with no repeatable structure, a UI-specific user journey, or a pure state machine without a workflow outcome.'::text
                    )
                  ),
           summary = 'A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. One-off incidents, UI-specific user journeys, and pure state machines without a workflow outcome belong elsewhere.',
           updated_at = now()
     WHERE data->>'template_handle' = 'business-processes'
       AND data->'predicate'->>'kind' = 'probabilistic'
       AND summary LIKE '%repeatable business process%';
  END IF;
END $$;
