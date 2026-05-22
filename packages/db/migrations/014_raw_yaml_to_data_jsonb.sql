-- 014_raw_yaml_to_data_jsonb.sql
-- ============================================================
-- Rename raw_yaml (text) → data (jsonb) on every entity table.
-- The column has been carrying JSON since the Postgres cut
-- (capture.server.ts uses JSON.stringify on every write); jsonb
-- makes path queries indexable and eliminates the parse-on-every-
-- read cost.
--
-- Idempotent: each ALTER fires only when the legacy column still
-- exists. Fresh installs land at the new shape via schema.sql and
-- skip the rename.
-- ============================================================

DO $rename_raw_yaml_to_data$
DECLARE
  tname text;
BEGIN
  FOREACH tname IN ARRAY ARRAY[
    'hosts',
    'collaborators',
    'principals',
    'organizations',
    'docos',
    'intents',
    'decisions',
    'rules',
    'guidance_primitives',
    'neuron_authoring_primitives',
    'org_guidance_primitives',
    'org_neuron_authoring_primitives',
    'actions',
    'logs',
    'evals',
    'states',
    'tags',
    'ideas',
    'reference_entities'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = tname
         AND column_name = 'raw_yaml'
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN raw_yaml TYPE jsonb USING raw_yaml::jsonb', tname);
      EXECUTE format('ALTER TABLE %I RENAME COLUMN raw_yaml TO data', tname);
    END IF;
  END LOOP;
END
$rename_raw_yaml_to_data$;

-- GIN indexes on data for path-based filtering. jsonb_path_ops is
-- the smaller and faster opclass for the @> and -> lookups
-- perspectives + capture-time predicates do.

DO $add_data_gin_indexes$
DECLARE
  tname text;
BEGIN
  FOREACH tname IN ARRAY ARRAY[
    'intents',
    'ideas',
    'rules',
    'decisions',
    'actions',
    'logs',
    'evals',
    'states',
    'reference_entities',
    'guidance_primitives',
    'neuron_authoring_primitives'
  ]
  LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I USING gin (data jsonb_path_ops)',
      tname || '_data_gin',
      tname
    );
  END LOOP;
END
$add_data_gin_indexes$;
