-- 011_doco_scoped_primitives_only.sql
-- ============================================================
-- Primitives now belong only to Docos. Remove the legacy org-level
-- primitive tables and the org branch of the primitive FTS table.
-- ============================================================

DO $doco_scoped_primitives_only$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'audit_events'
       AND column_name = 'org_id'
  ) THEN
    DELETE FROM audit_events
     WHERE org_id IS NOT NULL
       AND entity_type IN ('guidance_primitive', 'neuron_authoring_primitive');
  END IF;

  -- Guard the remainder on the legacy table name existing. On a
  -- fresh schema (post-024 baseline) the table is now named
  -- `entity_fts_policies` and this migration is a no-op.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'entity_fts_primitives'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'entity_fts_primitives'
         AND column_name = 'org_id'
    ) THEN
      DELETE FROM entity_fts_primitives
       WHERE org_id IS NOT NULL;

      DROP INDEX IF EXISTS entity_fts_primitives_org_idx;
      ALTER TABLE entity_fts_primitives DROP CONSTRAINT IF EXISTS entity_fts_primitives_check;
      ALTER TABLE entity_fts_primitives DROP COLUMN org_id;
    END IF;

    DELETE FROM entity_fts_primitives
     WHERE doco_id IS NULL;

    ALTER TABLE entity_fts_primitives ALTER COLUMN doco_id SET NOT NULL;
  END IF;
END
$doco_scoped_primitives_only$;

DROP TABLE IF EXISTS org_guidance_primitives CASCADE;
DROP TABLE IF EXISTS org_neuron_authoring_primitives CASCADE;
