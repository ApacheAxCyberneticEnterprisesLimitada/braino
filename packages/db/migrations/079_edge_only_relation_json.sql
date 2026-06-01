-- 079_edge_only_relation_json.sql — remove relation-shaped node JSON from
-- existing Docos and keep all graph relationships as ordinary edge rows.

DO $do$
BEGIN
  IF to_regclass('public.edges') IS NOT NULL THEN
    DROP INDEX IF EXISTS edges_live_uniq;

    UPDATE edges
       SET origin = 'authored'
     WHERE origin <> 'authored';

    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_origin_chk') THEN
      ALTER TABLE edges DROP CONSTRAINT edges_origin_chk;
    END IF;

    ALTER TABLE edges ADD CONSTRAINT edges_origin_chk
      CHECK (origin IN ('authored')) NOT VALID;

    UPDATE edges
       SET from_id = to_id,
           to_id = from_id,
           from_node_type = to_node_type,
           to_node_type = from_node_type,
           edge_type = 'flows_to',
           props = NULLIF(COALESCE(props, '{}'::jsonb) - 'source_field' - 'role', '{}'::jsonb)
     WHERE edge_type = 'preceded_by'
        OR (edge_type = 'flows_to'
            AND (props->>'role' = 'predecessor' OR props->>'source_field' = 'preceded_by'));

    UPDATE edges
       SET edge_type = 'flows_to',
           props = NULLIF(COALESCE(props, '{}'::jsonb) - 'source_field' - 'role', '{}'::jsonb)
     WHERE edge_type = 'sequence_flow'
        OR (edge_type = 'flows_to'
            AND (props->>'role' = 'sequence' OR props->>'source_field' = 'sequence_to'));

    WITH edge_roles(old_type, new_type, role) AS (
      VALUES
        ('serves', 'supports', 'serves'),
        ('enacts', 'supports', 'enacts'),
        ('tests', 'supports', 'tests'),
        ('implemented_by', 'supports', 'implemented_by'),
        ('gated_by', 'constrained_by', 'gated_by'),
        ('consults', 'constrained_by', 'consults'),
        ('born_from', 'derived_from', 'born_from'),
        ('templated_by', 'derived_from', 'templated_by'),
        ('superseded_by', 'replaces', 'superseded_by'),
        ('reports_to', 'has_parent', 'reports_to'),
        ('dotted_reports_to', 'has_parent', 'dotted_reports_to'),
        ('performed_by', 'attributed_to', 'performed_by'),
        ('owned_by', 'attributed_to', 'owned_by'),
        ('has_stakeholder', 'attributed_to', 'has_stakeholder'),
        ('decided_by', 'attributed_to', 'decided_by'),
        ('same_occupant_as', 'relates_to', 'same_occupant_as')
    )
    UPDATE edges e
       SET edge_type = edge_roles.new_type,
           props = NULLIF(
             (COALESCE(e.props, '{}'::jsonb) - 'source_field') ||
               jsonb_build_object('role', edge_roles.role),
             '{}'::jsonb
           )
      FROM edge_roles
     WHERE e.edge_type = edge_roles.old_type;

    UPDATE edges
       SET props = NULLIF(props - 'source_field', '{}'::jsonb)
     WHERE props ? 'source_field';

    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY doco_id, from_id, to_id, edge_type, COALESCE(props->>'role', '')
               ORDER BY created_at, id
             ) AS rn
        FROM edges
       WHERE lifecycle <> 'retired'
    )
    UPDATE edges e
       SET lifecycle = 'retired',
           retired_at = COALESCE(retired_at, now()),
           updated_at = now()
      FROM ranked
     WHERE e.id = ranked.id
       AND ranked.rn > 1;

    CREATE UNIQUE INDEX IF NOT EXISTS edges_live_uniq
      ON edges (
        doco_id,
        from_id,
        to_id,
        edge_type,
        COALESCE(props->>'role', '')
      ) WHERE lifecycle <> 'retired';
  END IF;

  IF to_regclass('public.edge_versions') IS NOT NULL THEN
    ALTER TABLE edge_versions DISABLE TRIGGER edge_versions_append_only_row;

    UPDATE edge_versions ev
       SET payload = to_jsonb(e)
      FROM edges e
     WHERE ev.entity_id = e.id
       AND ev.entity_type = 'edge';

    ALTER TABLE edge_versions ENABLE TRIGGER edge_versions_append_only_row;
  END IF;

  IF to_regclass('public.changesets') IS NOT NULL THEN
    UPDATE changesets
       SET reason = 'extract BPMN sequence JSON into edge rows'
     WHERE metadata->>'migration' = '077_materialize_bpmn_sequence_edges'
       AND reason <> 'extract BPMN sequence JSON into edge rows';

    UPDATE changesets
       SET reason = 'extract node JSON relations into edge rows'
     WHERE metadata->>'migration' = '078_materialize_json_relation_edges'
       AND reason <> 'extract node JSON relations into edge rows';
  END IF;

  IF to_regclass('public.nodes') IS NOT NULL THEN
    UPDATE nodes
       SET data =
             data
               - 'sequence_to'
               - 'preceded_by'
               - 'intent_ids'
               - 'decision_ids'
               - 'gated_by'
               - 'rules_consulted'
               - 'target_ref'
               - 'born_from'
               - 'superseded_by'
               - 'implemented_by'
               - 'reports_to'
               - 'dotted_reports_to'
               - 'same_occupant_as'
               - 'actor_id'
               - 'actor_principal_id'
               - 'actors'
               - 'actors_principal_ids'
               - 'wanted_by'
               - 'wanted_by_principal_id'
               - 'owner_id'
               - 'decided_by'
               - 'decided_by_principal_id'
               - 'authored_by'
               - 'authored_by_principal_id'
               - 'created_by_principal_id'
               - 'parent_intent_id'
               - 'stakeholders'
               - 'stakeholders_principal_ids'
               - 'template_id'
               - 'relates_to',
           updated_at = now()
     WHERE data ?| ARRAY[
       'sequence_to',
       'preceded_by',
       'intent_ids',
       'decision_ids',
       'gated_by',
       'rules_consulted',
       'target_ref',
       'born_from',
       'superseded_by',
       'implemented_by',
       'reports_to',
       'dotted_reports_to',
       'same_occupant_as',
       'actor_id',
       'actor_principal_id',
       'actors',
       'actors_principal_ids',
       'wanted_by',
       'wanted_by_principal_id',
       'owner_id',
       'decided_by',
       'decided_by_principal_id',
       'authored_by',
       'authored_by_principal_id',
       'created_by_principal_id',
       'parent_intent_id',
       'stakeholders',
       'stakeholders_principal_ids',
       'template_id',
       'relates_to'
     ];
  END IF;
END
$do$;
