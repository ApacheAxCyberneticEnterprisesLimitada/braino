-- 030_rename_follows_to_preceded_by.sql
-- ============================================================
-- Rename the `follows` synapse / field to `preceded_by`.
--
-- Background. The `follows` synapse expressed BPMN sequence flow:
-- `X.follows = [Y]` meant "Y precedes X". Two valid English readings
-- of "follows" (`X follows Y` = X after Y vs `X is followed by Y` =
-- Y after X) made the direction non-obvious, and readers regularly
-- inverted it. Pick the unambiguous passive-voice name, symmetric
-- with the existing `triggered_by`: `X.preceded_by = [Y]` is exactly
-- "Y precedes X" — direction is in the name.
--
-- This migration:
--   1. Renames `synapse_type = 'follows'` to `'preceded_by'` in the
--      synapses materialization table.
--   2. Renames the `follows` JSON key to `preceded_by` in every
--      neuron data column that may carry it.
--   3. Rewrites authoring-policy predicates with
--      `synapse_type = 'follows'` to `'preceded_by'` (template-seeded
--      and user-authored alike).
--
-- Idempotent via `WHERE` guards — safe to re-run if `ensureSchema`
-- retries on a partial run.
-- ============================================================

-- 1. synapses table — rename canonical type.
UPDATE synapses
   SET synapse_type = 'preceded_by'
 WHERE synapse_type = 'follows';

-- 2. JSON key rename across every neuron table that may carry
--    `data.follows`. `data - 'follows'` drops the old key, then we
--    re-attach the array under the new key.
DO $$
DECLARE
  t text;
  neuron_tables text[] := ARRAY[
    'actions', 'logs', 'states', 'decisions',
    'intents', 'rules', 'evals', 'references', 'ideas', 'principals'
  ];
BEGIN
  FOREACH t IN ARRAY neuron_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format(
        $sql$
          UPDATE %I
             SET data = (data - 'follows')
                        || jsonb_build_object('preceded_by', data->'follows')
           WHERE data ? 'follows'
        $sql$,
        t
      );
    END IF;
  END LOOP;
END$$;

-- 3. Authoring-policy predicates — both template-seeded and
--    user-authored. The predicate JSON looks like:
--      {"kind": "requires_synapse", "synapse_type": "follows", ...}
UPDATE neuron_authoring_policies
   SET data = jsonb_set(data, '{predicate,synapse_type}', '"preceded_by"'::jsonb)
 WHERE data->'predicate'->>'synapse_type' = 'follows';
