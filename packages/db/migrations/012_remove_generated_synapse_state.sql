-- 012_remove_generated_synapse_state.sql
-- ============================================================
-- Synapses are now only materialized from authored reference fields.
-- Remove the storage column that distinguished generated links and
-- purge generated link metadata from persisted entity frontmatter.
-- ============================================================

DROP INDEX IF EXISTS synapses_attribution_idx;

ALTER TABLE synapses
  DROP COLUMN IF EXISTS attribution;

DO $remove_generated_synapse_state$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'intents',
    'ideas',
    'rules',
    'decisions',
    'actions',
    'logs',
    'evals',
    'reference_entities',
    'states',
    'guidance_primitives',
    'neuron_authoring_primitives'
  ]
  LOOP
    EXECUTE format(
      'UPDATE %I
          SET raw_yaml = (%I.raw_yaml::jsonb - %L)::text
        WHERE raw_yaml IS NOT NULL
          AND raw_yaml::jsonb ? %L',
      table_name,
      table_name,
      'auto_synapses',
      'auto_synapses'
    );
  END LOOP;
END
$remove_generated_synapse_state$;
