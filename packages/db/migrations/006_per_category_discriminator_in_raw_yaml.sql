-- 006_per_category_discriminator_in_raw_yaml.sql
-- ============================================================
-- The big rename (migration 005) collapsed every per-category
-- discriminator into a single `entity_type` field in raw_yaml. That
-- was a deviation from the agreed plan: per-category interfaces own
-- their discriminator name.
--
-- Restore the per-category shape in stored raw_yaml so the entity
-- detail page (which renders `Object.entries(parseYaml(raw_yaml))`)
-- shows the right field name for each category:
--
--   Neurons (intent/idea/rule/decision/action/log/eval/reference/
--   state/principal):
--     entity_type: <value>   →   neuron_type: <value>
--
--   Primitives (guidance_primitive, neuron_authoring_primitive):
--     entity_type: guidance_primitive          →  primitive_kind: guidance
--     entity_type: neuron_authoring_primitive  →  primitive_kind: neuron_authoring
--
--   Collaborator:
--     remove `entity_type: collaborator` — `kind` already carries
--     the person/agent value.
--
--   Docos, Organizations:
--     remove `entity_type: <value>` — these categories have no
--     per-row discriminator.
--
-- Wrapped in the migration runner's transaction; idempotent on
-- replay (regex passes are no-ops once the rewrite has happened).
-- ============================================================

DO $rename_v006$
BEGIN
  IF EXISTS (
    SELECT 1 FROM doco_meta WHERE key = 'rename_v006' AND value = 'done'
  ) THEN
    RAISE NOTICE 'rename_v006: already applied, skipping';
    RETURN;
  END IF;

  RAISE NOTICE 'rename_v006: starting';

  -- ──────────────────────────────────────────────────────────────────
  -- Neurons: entity_type → neuron_type (KEY rename, value unchanged).
  -- ──────────────────────────────────────────────────────────────────
  UPDATE intents             SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE ideas               SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE rules               SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE decisions           SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE actions             SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE logs                SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE evals               SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE reference_entities  SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE states              SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');
  UPDATE principals          SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M', 'neuron_type', 'g');

  -- ──────────────────────────────────────────────────────────────────
  -- Primitives: entity_type:guidance_primitive → primitive_kind:guidance
  --             entity_type:neuron_authoring_primitive → primitive_kind:neuron_authoring
  --
  -- Two passes: first replace the value, then the key. Order matters
  -- so we don't rewrite a key that we'd then look for as a value.
  -- ──────────────────────────────────────────────────────────────────

  -- guidance_primitives
  UPDATE guidance_primitives          SET raw_yaml = regexp_replace(raw_yaml, '"guidance_primitive"',         '"guidance"',         'g');
  UPDATE guidance_primitives          SET raw_yaml = regexp_replace(raw_yaml, ':\s*guidance_primitive\M',     ': guidance',         'g');
  UPDATE guidance_primitives          SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M',              'primitive_kind',     'g');

  UPDATE org_guidance_primitives      SET raw_yaml = regexp_replace(raw_yaml, '"guidance_primitive"',         '"guidance"',         'g');
  UPDATE org_guidance_primitives      SET raw_yaml = regexp_replace(raw_yaml, ':\s*guidance_primitive\M',     ': guidance',         'g');
  UPDATE org_guidance_primitives      SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M',              'primitive_kind',     'g');

  -- neuron_authoring_primitives
  UPDATE neuron_authoring_primitives  SET raw_yaml = regexp_replace(raw_yaml, '"neuron_authoring_primitive"', '"neuron_authoring"', 'g');
  UPDATE neuron_authoring_primitives  SET raw_yaml = regexp_replace(raw_yaml, ':\s*neuron_authoring_primitive\M', ': neuron_authoring', 'g');
  UPDATE neuron_authoring_primitives  SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M',              'primitive_kind',     'g');

  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '"neuron_authoring_primitive"', '"neuron_authoring"', 'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, ':\s*neuron_authoring_primitive\M', ': neuron_authoring', 'g');
  UPDATE org_neuron_authoring_primitives SET raw_yaml = regexp_replace(raw_yaml, '\mentity_type\M',              'primitive_kind',     'g');

  -- ──────────────────────────────────────────────────────────────────
  -- Collaborators: drop `entity_type: collaborator` (redundant; `kind`
  -- already carries person/agent).
  --
  -- The raw_yaml is stored as a JSON object (the upsert path does
  -- JSON.stringify). Use jsonb minus to strip the key cleanly.
  -- ──────────────────────────────────────────────────────────────────
  UPDATE collaborators
     SET raw_yaml = (raw_yaml::jsonb - 'entity_type')::text
   WHERE raw_yaml::jsonb ? 'entity_type';

  -- ──────────────────────────────────────────────────────────────────
  -- Docos + Organizations: drop `entity_type` AND the legacy `node_type`
  -- entirely (no per-row discriminator at this category level).
  -- Migration 005 missed `node_type` in docos/organizations because its
  -- raw_yaml regex pass for those tables only handled allowed_node_types
  -- and default_node_lifecycle, not bare node_type.
  -- ──────────────────────────────────────────────────────────────────
  UPDATE docos
     SET raw_yaml = (raw_yaml::jsonb - 'entity_type' - 'node_type')::text
   WHERE raw_yaml::jsonb ?| ARRAY['entity_type', 'node_type'];

  UPDATE organizations
     SET raw_yaml = (raw_yaml::jsonb - 'entity_type' - 'node_type')::text
   WHERE raw_yaml::jsonb ?| ARRAY['entity_type', 'node_type'];

  -- ──────────────────────────────────────────────────────────────────
  -- Sentinel.
  -- ──────────────────────────────────────────────────────────────────
  INSERT INTO doco_meta (key, value) VALUES ('rename_v006', 'done')
    ON CONFLICT (key) DO UPDATE SET value = 'done';

  RAISE NOTICE 'rename_v006: done';
END
$rename_v006$;
