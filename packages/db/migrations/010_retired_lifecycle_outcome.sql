-- 010_retired_lifecycle_outcome.sql
-- ============================================================
-- Normalize lifecycle to the four-state model:
--   drafted | proposed | active | retired
--
-- Success/failure now live in `outcome`, and replacement lives in the
-- `superseded_by` reference field that materializes as a synapse.
--
-- No compatibility aliases: existing noncanonical lifecycle values are
-- rewritten to `retired`.
-- ============================================================

CREATE OR REPLACE FUNCTION pg_temp.doco_rewrite_lifecycle_json(input jsonb)
RETURNS jsonb
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN input IS NULL OR NOT (input ? 'lifecycle') THEN input
    WHEN input->>'lifecycle' = ANY (ARRAY['drafted','proposed','active','retired']::text[]) THEN input
    ELSE jsonb_set(input, '{lifecycle}', to_jsonb('retired'::text), true)
  END
$$;

DO $retired_lifecycle_v010$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'intents',
    'ideas',
    'rules',
    'decisions',
    'actions',
    'logs',
    'evals',
    'reference_entities',
    'states',
    'principals',
    'guidance_primitives',
    'neuron_authoring_primitives',
    'org_guidance_primitives',
    'org_neuron_authoring_primitives'
  ] LOOP
    EXECUTE format(
      $sql$
        UPDATE %I
           SET raw_yaml = pg_temp.doco_rewrite_lifecycle_json(raw_yaml::jsonb)::text
         WHERE raw_yaml IS NOT NULL
           AND raw_yaml::jsonb ? 'lifecycle'
           AND NOT (raw_yaml::jsonb->>'lifecycle' = ANY (ARRAY['drafted','proposed','active','retired']::text[]))
      $sql$,
      tbl
    );

    EXECUTE format(
      $sql$
        UPDATE %I
           SET lifecycle = 'retired'
         WHERE lifecycle IS NOT NULL
           AND NOT (lifecycle = ANY (ARRAY['drafted','proposed','active','retired']::text[]))
      $sql$,
      tbl
    );
  END LOOP;

  UPDATE audit_events
     SET before_json = pg_temp.doco_rewrite_lifecycle_json(before_json)
   WHERE before_json IS NOT NULL
     AND before_json ? 'lifecycle'
     AND NOT (before_json->>'lifecycle' = ANY (ARRAY['drafted','proposed','active','retired']::text[]));

  UPDATE audit_events
     SET after_json = pg_temp.doco_rewrite_lifecycle_json(after_json)
   WHERE after_json IS NOT NULL
     AND after_json ? 'lifecycle'
     AND NOT (after_json->>'lifecycle' = ANY (ARRAY['drafted','proposed','active','retired']::text[]));

  INSERT INTO doco_meta (key, value) VALUES ('retired_lifecycle_v010', 'done')
    ON CONFLICT (key) DO UPDATE SET value = 'done';
END
$retired_lifecycle_v010$;
