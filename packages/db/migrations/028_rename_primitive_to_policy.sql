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
--   * `entity_fts_policies.primitive_kind` column → `policy_kind`,
--     with its CHECK constraint rebuilt.
--   * audit_events.entity_type values: "guidance_primitive" →
--     "guidance_policy", same for neuron_authoring.
--
-- The migration is idempotent: every block checks current state
-- before mutating, so a partial replay (or a fresh-from-schema.sql
-- database that already has the new names) is a safe no-op.
-- ============================================================

-- 1. Rewrite jsonb field names in place BEFORE renaming the tables,
--    so old data isn't visible under the new names with stale keys.

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

-- 2. Rewrite primary-key prefixes on the rows themselves AND inside
--    the `data` jsonb (which carries `id` denormalized). Synapses /
--    audit / FTS rows that reference these ids are migrated in their
--    own steps below.

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

-- 3. Synapses table: any row whose from_id/to_id points at a renamed
--    primitive needs the prefix rewritten too.

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

-- 4. Audit events: entity_type strings get the new vocabulary so
--    history-page filters keep working after the rename.

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

-- 5. Embeddings: entity_id may point at a renamed primitive; same
--    REPLACE treatment.

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

-- 6. FTS table: rename column primitive_kind → policy_kind, rebuild
--    its CHECK constraint, then rename the table itself, then update
--    entity_id values to the new prefixes. The rebuilt search_tsv
--    expression is computed on the existing summary/body and doesn't
--    need data changes — only structural.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entity_fts_primitives' AND column_name = 'primitive_kind'
  ) THEN
    ALTER TABLE entity_fts_primitives RENAME COLUMN primitive_kind TO policy_kind;
  END IF;
END $$;

DO $$ DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'entity_fts_primitives'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%primitive_kind%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE entity_fts_primitives DROP CONSTRAINT %I', cname);
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$ BEGIN
  -- Nested IFs so the inner EXISTS (which casts via `::regclass` and
  -- raises on a missing table) is only evaluated once the outer guard
  -- proves the table exists. AND short-circuiting doesn't reliably
  -- skip the cast in plpgsql, so the nesting is load-bearing.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts_primitives'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'entity_fts_primitives'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%policy_kind%'
    ) THEN
      ALTER TABLE entity_fts_primitives
        ADD CONSTRAINT entity_fts_primitives_policy_kind_check
        CHECK (policy_kind IN ('guidance', 'neuron_authoring'));
    END IF;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts_primitives') THEN
    UPDATE entity_fts_primitives
       SET entity_id = REPLACE(entity_id, 'guidance_primitive_', 'guidance_policy_')
     WHERE entity_id LIKE 'guidance_primitive_%';
    UPDATE entity_fts_primitives
       SET entity_id = REPLACE(entity_id, 'neuron_authoring_primitive_', 'neuron_authoring_policy_')
     WHERE entity_id LIKE 'neuron_authoring_primitive_%';
  END IF;
END $$;

-- 7. Rename the tables themselves and their indexes / constraints to
--    the new names.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guidance_primitives') THEN
    ALTER TABLE guidance_primitives RENAME TO guidance_policies;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'neuron_authoring_primitives') THEN
    ALTER TABLE neuron_authoring_primitives RENAME TO neuron_authoring_policies;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'entity_fts_primitives') THEN
    ALTER TABLE entity_fts_primitives RENAME TO entity_fts_policies;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'guidance_primitives_doco_idx') THEN
    ALTER INDEX guidance_primitives_doco_idx RENAME TO guidance_policies_doco_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'guidance_primitives_lifecycle_idx') THEN
    ALTER INDEX guidance_primitives_lifecycle_idx RENAME TO guidance_policies_lifecycle_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'neuron_authoring_primitives_doco_idx') THEN
    ALTER INDEX neuron_authoring_primitives_doco_idx RENAME TO neuron_authoring_policies_doco_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'neuron_authoring_primitives_lifecycle_idx') THEN
    ALTER INDEX neuron_authoring_primitives_lifecycle_idx RENAME TO neuron_authoring_policies_lifecycle_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'entity_fts_primitives_doco_idx') THEN
    ALTER INDEX entity_fts_primitives_doco_idx RENAME TO entity_fts_policies_doco_idx;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'entity_fts_primitives_tsv_idx') THEN
    ALTER INDEX entity_fts_primitives_tsv_idx RENAME TO entity_fts_policies_tsv_idx;
  END IF;
END $$;

-- 8. Audit-events op-kind values that mention primitive vocabulary —
--    none today, since the CHECK only allows the generic `entity.*`
--    set. Left as a no-op anchor for future migrations.
