-- 031_neuron_type_allowlists_admit_principal.sql
-- ============================================================
-- Add `principal` to every existing `requires_neuron_type` allowlist.
--
-- Background. The three shipped templates — user-flows,
-- state-machines, business-processes — each seed a
-- `requires_neuron_type` policy listing the neuron types valid
-- inside that Doco. None of the three included `principal`, so any
-- attempt to capture a new Principal (the role-personas referenced
-- by Action.actor_id / Intent.actors[] / etc.) was rejected at the
-- gate with HTTP 422.
--
-- Principals aren't substantive content of a flow — they're the
-- actors that operate in it. Every Doco that models actors needs to
-- create them. Excluding `principal` from the allowlist was an
-- oversight in the original templates.
--
-- This migration rewrites every existing template-seeded
-- `requires_neuron_type` policy in `neuron_authoring_policies` to
-- append `"principal"` to its `data.predicate.neuron_types` array
-- (no-op when already present). User-authored allowlists are also
-- picked up because the predicate shape is the same — owners can
-- still re-tighten by editing the policy after the migration.
--
-- Idempotent: the JSONB `?` test skips policies that already list
-- `"principal"`, so re-running this migration on a fully-migrated
-- DB does nothing.
-- ============================================================

UPDATE neuron_authoring_policies
   SET data = jsonb_set(
                data,
                '{predicate,neuron_types}',
                (data->'predicate'->'neuron_types') || '["principal"]'::jsonb
              ),
       updated_at = now()
 WHERE data->'predicate'->>'kind' = 'requires_neuron_type'
   AND NOT (data->'predicate'->'neuron_types') ? 'principal';
