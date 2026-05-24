-- 028_rename_primitive_to_policy.sql
-- ============================================================
-- Big vocabulary rename: "primitive" → "policy" across the whole
-- Doco surface. Captures the "policy" framing more naturally — a
-- primitive was always a Doco-level enforcement / guidance rule, and
-- "policy" matches industry usage (authoring policies, governance
-- policies) better than the original placeholder name.
--
-- Surface area touched by this migration:
--   * Tables: guidance_primitives → guidance_policies,
--     neuron_authoring_primitives → neuron_authoring_policies,
--     entity_fts_primitives → entity_fts_policies.
--   * jsonb fields: primitive_kind → policy_kind on every row.
--   * Primary-key prefixes: guidance_primitive_<ULID> →
--     guidance_policy_<ULID>; same for neuron_authoring_*.
--   * `entity_fts_policies.primitive_kind` column → `policy_kind`.
--   * audit_events.entity_type values: "guidance_primitive" →
--     "guidance_policy", same for neuron_authoring.
--
-- Strategy: schema.sql already creates the post-rename tables
-- (`guidance_policies`, `neuron_authoring_policies`,
-- `entity_fts_policies`) with their indexes/constraints. We can't
-- `ALTER TABLE ... RENAME TO ...` over a table that already exists,
-- so this migration **moves rows from the legacy tables into the
-- already-created new tables and drops the legacy tables**. That
-- works for both startup paths:
--
--   1. Fresh DB: only the new tables exist (schema baseline). Every
--      `IF EXISTS legacy_table` guard short-circuits and this
--      migration is a no-op.
--
--   2. Existing prod DB: both old and new tables exist (new tables
--      empty, created by today's startup; old tables carry the real
--      rows). Rows get rewritten + copied across, then old tables
--      drop.
--
-- The migration is idempotent: every block re-checks state before
-- mutating, so a partial replay is safe.
-- ============================================================

-- 1. Rewrite jsonb `primitive_kind` → `policy_kind` IN PLACE on the
--    legacy tables (so when we copy rows over, the new column name is
--    correct in `data`).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guidance_primitives') THEN
    UPDATE guidance_primitives
       SET data = (
             jsonb_set(
               data - 'primitive_kind',
               '{policy_kind}',
               COALESCE(data->'primitive_kind', '"guidance"'::jsonb)
             )
           )
     WHERE data ? 'primitive_kind' OR NOT (data ? 'policy_kind');
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_primitives') THEN
    UPDATE neuron_authoring_primitives
       SET data = (
             jsonb_set(
               data - 'primitive_kind',
               '{policy_kind}',
               COALESCE(data->'primitive_kind', '"neuron_authoring"'::jsonb)
             )
           )
     WHERE data ? 'primitive_kind' OR NOT (data ? 'policy_kind');
  END IF;
END $$;

-- 2. Rewrite primary-key prefixes on the legacy rows AND inside the
--    `data` jsonb (which mirrors `id` denormalized).

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guidance_primitives') THEN
    UPDATE guidance_primitives
       SET id = REPLACE(id, 'guidance_primitive_', 'guidance_policy_'),
           data = jsonb_set(
                    data,
                    '{id}',
                    to_jsonb(REPLACE(data->>'id', 'guidance_primitive_', 'guidance_policy_'))
                  )
     WHERE id LIKE 'guidance_primitive_%';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_primitives') THEN
    UPDATE neuron_authoring_primitives
       SET id = REPLACE(id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_'),
           data = jsonb_set(
                    data,
                    '{id}',
                    to_jsonb(REPLACE(data->>'id', 'neuron_authoring_primitive_', 'neuron_authoring_policy_'))
                  )
     WHERE id LIKE 'neuron_authoring_primitive_%';
  END IF;
END $$;

-- 3. Synapses table: rewrite from_id/to_id + from_neuron_type/
--    to_neuron_type for anything pointing at the renamed policies.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'synapses') THEN
    UPDATE synapses
       SET from_id = REPLACE(from_id, 'guidance_primitive_', 'guidance_policy_')
     WHERE from_id LIKE 'guidance_primitive_%';
    UPDATE synapses
       SET to_id = REPLACE(to_id, 'guidance_primitive_', 'guidance_policy_')
     WHERE to_id LIKE 'guidance_primitive_%';
    UPDATE synapses
       SET from_id = REPLACE(from_id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_')
     WHERE from_id LIKE 'neuron_authoring_primitive_%';
    UPDATE synapses
       SET to_id = REPLACE(to_id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_')
     WHERE to_id LIKE 'neuron_authoring_primitive_%';
    UPDATE synapses
       SET from_neuron_type = 'guidance_policy'
     WHERE from_neuron_type = 'guidance_primitive';
    UPDATE synapses
       SET to_neuron_type = 'guidance_policy'
     WHERE to_neuron_type = 'guidance_primitive';
    UPDATE synapses
       SET from_neuron_type = 'neuron_authoring_policy'
     WHERE from_neuron_type = 'neuron_authoring_primitive';
    UPDATE synapses
       SET to_neuron_type = 'neuron_authoring_policy'
     WHERE to_neuron_type = 'neuron_authoring_primitive';
  END IF;
END $$;

-- 4. Audit events: entity_type strings + entity_id prefixes get the
--    new vocabulary so history-page filters keep working.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_events') THEN
    UPDATE audit_events
       SET entity_type = 'guidance_policy',
           entity_id = REPLACE(entity_id, 'guidance_primitive_', 'guidance_policy_')
     WHERE entity_type = 'guidance_primitive';
    UPDATE audit_events
       SET entity_type = 'neuron_authoring_policy',
           entity_id = REPLACE(entity_id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_')
     WHERE entity_type = 'neuron_authoring_primitive';
  END IF;
END $$;

-- 5. Embeddings rows that pointed at renamed policies.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'embeddings') THEN
    UPDATE embeddings
       SET entity_id = REPLACE(entity_id, 'guidance_primitive_', 'guidance_policy_')
     WHERE entity_id LIKE 'guidance_primitive_%';
    UPDATE embeddings
       SET entity_id = REPLACE(entity_id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_')
     WHERE entity_id LIKE 'neuron_authoring_primitive_%';
  END IF;
END $$;

-- 6. Move rows from the legacy tables into the (already-created)
--    new tables, then drop the legacy tables. ON CONFLICT (id) DO
--    NOTHING covers the partial-replay case where a row was already
--    moved.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guidance_primitives') THEN
    INSERT INTO guidance_policies
      (id, doco_id, summary, lifecycle, body_md, data,
       created_at, created_by, updated_at, updated_by)
    SELECT id, doco_id, summary, lifecycle, body_md, data,
           created_at, created_by, updated_at, updated_by
      FROM guidance_primitives
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE guidance_primitives CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_primitives') THEN
    INSERT INTO neuron_authoring_policies
      (id, doco_id, summary, lifecycle, body_md, data,
       created_at, created_by, updated_at, updated_by)
    SELECT id, doco_id, summary, lifecycle, body_md, data,
           created_at, created_by, updated_at, updated_by
      FROM neuron_authoring_primitives
    ON CONFLICT (id) DO NOTHING;
    DROP TABLE neuron_authoring_primitives CASCADE;
  END IF;
END $$;

-- 7. Same for the FTS table. The legacy `primitive_kind` column maps
--    onto the new `policy_kind` column — same CHECK constraint values.
--    `search_tsv` is GENERATED so it doesn't appear in the column
--    list either side.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts_primitives') THEN
    INSERT INTO entity_fts_policies (entity_id, doco_id, policy_kind, summary, body)
    SELECT
      CASE
        WHEN entity_id LIKE 'guidance_primitive_%'
          THEN REPLACE(entity_id, 'guidance_primitive_', 'guidance_policy_')
        WHEN entity_id LIKE 'neuron_authoring_primitive_%'
          THEN REPLACE(entity_id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_')
        ELSE entity_id
      END,
      doco_id, primitive_kind, summary, body
    FROM entity_fts_primitives
    ON CONFLICT (entity_id) DO NOTHING;
    DROP TABLE entity_fts_primitives CASCADE;
  END IF;
END $$;
