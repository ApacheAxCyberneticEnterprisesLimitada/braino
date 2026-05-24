-- 029_normalize_legacy_predicate_keys.sql
-- ============================================================
-- One-time scrub of pre-vocab-sweep (nodes → neurons / edges → synapses)
-- keys still buried in `neuron_authoring_policies.data->'predicate'`
-- and the policy-level `fires_when_node_lifecycle` field. The runtime
-- normalizer in authoring-runner.server.ts rewrote these at read time;
-- after this migration runs the canonical post-rename keys are
-- materialized in `data`, the normalizer can be deleted, and the
-- engine reads the policies straight.
--
-- Rewrites (only when the post-rename key is absent — never overwrite):
--   * data.predicate.when_node_type      → data.predicate.when_neuron_type
--   * data.predicate.target_node_type    → data.predicate.target_neuron_type
--   * data.predicate.incoming_node_type  → data.predicate.incoming_neuron_type
--   * data.fires_when_node_lifecycle     → data.fires_when_neuron_lifecycle
-- ============================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_policies') THEN

    -- predicate.when_node_type → predicate.when_neuron_type
    UPDATE neuron_authoring_policies
       SET data = jsonb_set(
                    data #- '{predicate,when_node_type}',
                    '{predicate,when_neuron_type}',
                    data #> '{predicate,when_node_type}'
                  )
     WHERE data #> '{predicate,when_node_type}' IS NOT NULL
       AND data #> '{predicate,when_neuron_type}' IS NULL;

    -- Drop any leftover when_node_type when the post-rename key was
    -- already populated (so we don't overwrite, just clean up).
    UPDATE neuron_authoring_policies
       SET data = data #- '{predicate,when_node_type}'
     WHERE data #> '{predicate,when_node_type}' IS NOT NULL;

    -- predicate.target_node_type → predicate.target_neuron_type
    UPDATE neuron_authoring_policies
       SET data = jsonb_set(
                    data #- '{predicate,target_node_type}',
                    '{predicate,target_neuron_type}',
                    data #> '{predicate,target_node_type}'
                  )
     WHERE data #> '{predicate,target_node_type}' IS NOT NULL
       AND data #> '{predicate,target_neuron_type}' IS NULL;

    UPDATE neuron_authoring_policies
       SET data = data #- '{predicate,target_node_type}'
     WHERE data #> '{predicate,target_node_type}' IS NOT NULL;

    -- predicate.incoming_node_type → predicate.incoming_neuron_type
    UPDATE neuron_authoring_policies
       SET data = jsonb_set(
                    data #- '{predicate,incoming_node_type}',
                    '{predicate,incoming_neuron_type}',
                    data #> '{predicate,incoming_node_type}'
                  )
     WHERE data #> '{predicate,incoming_node_type}' IS NOT NULL
       AND data #> '{predicate,incoming_neuron_type}' IS NULL;

    UPDATE neuron_authoring_policies
       SET data = data #- '{predicate,incoming_node_type}'
     WHERE data #> '{predicate,incoming_node_type}' IS NOT NULL;

    -- fires_when_node_lifecycle → fires_when_neuron_lifecycle
    UPDATE neuron_authoring_policies
       SET data = jsonb_set(
                    data - 'fires_when_node_lifecycle',
                    '{fires_when_neuron_lifecycle}',
                    data->'fires_when_node_lifecycle'
                  )
     WHERE data ? 'fires_when_node_lifecycle'
       AND NOT (data ? 'fires_when_neuron_lifecycle');

    UPDATE neuron_authoring_policies
       SET data = data - 'fires_when_node_lifecycle'
     WHERE data ? 'fires_when_node_lifecycle';
  END IF;
END $$;
