-- 078_materialize_json_relation_edges.sql — one-time extraction of graph
-- relations from node JSON into first-class edge rows.
--
-- Idempotent: skips any existing live edge with the same (doco, from, to, type)
-- and then strips the legacy JSON keys from nodes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION _doco_078_jsonb_stable(value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'null' THEN 'null'
    WHEN 'boolean' THEN value::text
    WHEN 'number' THEN value::text
    WHEN 'string' THEN value::text
    WHEN 'array' THEN '[' || COALESCE((
      SELECT string_agg(_doco_078_jsonb_stable(elem), ',' ORDER BY ord)
        FROM jsonb_array_elements(value) WITH ORDINALITY AS a(elem, ord)
    ), '') || ']'
    WHEN 'object' THEN '{' || COALESCE((
      SELECT string_agg(to_jsonb(key)::text || ':' || _doco_078_jsonb_stable(value -> key), ',' ORDER BY key)
        FROM jsonb_object_keys(value) AS key
    ), '') || '}'
  END
$$;

DO $do$
BEGIN
  IF to_regclass('public.nodes') IS NULL OR to_regclass('public.edges') IS NULL THEN
    RAISE NOTICE '078: nodes/edges tables absent — schema.sql applies the final shape';
    RETURN;
  END IF;

  WITH sequence_candidates AS (
    SELECT n.doco_id,
           n.id AS from_id,
           n.node_type AS from_node_type,
           CASE
             WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}'
             WHEN jsonb_typeof(entry.value) = 'object' THEN entry.value->>'target'
             ELSE NULL
           END AS target_id,
           'sequence_flow'::text AS edge_type,
           NULLIF(
             CASE
               WHEN jsonb_typeof(entry.value) = 'object' THEN entry.value - 'target'
               ELSE '{}'::jsonb
             END,
             '{}'::jsonb
           ) AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.data->'sequence_to') = 'array' THEN n.data->'sequence_to' ELSE '[]'::jsonb END
      ) AS entry(value)
  ),
  preceded_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           CASE
             WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}'
             WHEN jsonb_typeof(entry.value) = 'object' THEN COALESCE(entry.value->>'target', entry.value->>'ref')
             ELSE NULL
           END AS target_id,
           'preceded_by'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(n.data->'preceded_by') = 'array' THEN n.data->'preceded_by' ELSE '[]'::jsonb END
      ) AS entry(value)
  ),
  intent_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'serves'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'intent_ids') = 'array' THEN n.data->'intent_ids' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  decision_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'enacts'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'decision_ids') = 'array' THEN n.data->'decision_ids' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  gated_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'gated_by'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'gated_by') = 'array' THEN n.data->'gated_by' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  consulted_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'consults'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'rules_consulted') = 'array' THEN n.data->'rules_consulted' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  implemented_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'implemented_by'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'implemented_by') = 'array' THEN n.data->'implemented_by' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  dotted_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'dotted_reports_to'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'dotted_reports_to') = 'array' THEN n.data->'dotted_reports_to' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  occupant_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'same_occupant_as'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'same_occupant_as') = 'array' THEN n.data->'same_occupant_as' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  stakeholder_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'has_stakeholder'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'stakeholders') = 'array' THEN n.data->'stakeholders' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  relates_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           ref.id AS target_id, 'relates_to'::text AS edge_type, NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(n.data->'relates_to') = 'array' THEN n.data->'relates_to' ELSE '[]'::jsonb END
      ) AS ref(id)
  ),
  scalar_candidates AS (
    SELECT n.doco_id, n.id AS from_id, n.node_type AS from_node_type,
           n.data->>'target_ref' AS target_id, 'tests'::text AS edge_type,
           NULL::jsonb AS props, COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n WHERE jsonb_typeof(n.data->'target_ref') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'born_from', 'born_from', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'born_from') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'superseded_by', 'superseded_by', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'superseded_by') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'reports_to', 'reports_to', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'reports_to') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'actor_id', 'performed_by', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'actor_id') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'owner_id', 'owned_by', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'owner_id') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'parent_intent_id', 'has_parent', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'parent_intent_id') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'decided_by', 'decided_by', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'decided_by') = 'string'
    UNION ALL
    SELECT n.doco_id, n.id, n.node_type, n.data->>'template_id', 'templated_by', NULL::jsonb, COALESCE(n.updated_by, n.created_by)
      FROM nodes n WHERE jsonb_typeof(n.data->'template_id') = 'string'
  ),
  candidates AS (
    SELECT * FROM sequence_candidates
    UNION ALL SELECT * FROM preceded_candidates
    UNION ALL SELECT * FROM intent_candidates
    UNION ALL SELECT * FROM decision_candidates
    UNION ALL SELECT * FROM gated_candidates
    UNION ALL SELECT * FROM consulted_candidates
    UNION ALL SELECT * FROM implemented_candidates
    UNION ALL SELECT * FROM dotted_candidates
    UNION ALL SELECT * FROM occupant_candidates
    UNION ALL SELECT * FROM stakeholder_candidates
    UNION ALL SELECT * FROM relates_candidates
    UNION ALL SELECT * FROM scalar_candidates
  ),
  resolved AS (
    SELECT c.doco_id,
           c.from_id,
           c.from_node_type,
           target.id AS to_id,
           target.node_type AS to_node_type,
           c.edge_type,
           c.props,
           c.actor
      FROM candidates c
      JOIN nodes source
        ON source.doco_id = c.doco_id
       AND source.id = c.from_id
      JOIN nodes target
        ON target.doco_id = c.doco_id
       AND target.id = c.target_id
     WHERE c.target_id IS NOT NULL
       AND c.from_id <> target.id
       AND COALESCE(source.lifecycle, 'asserted') <> 'retired'
       AND COALESCE(target.lifecycle, 'asserted') <> 'retired'
  ),
  deduped AS (
    SELECT DISTINCT ON (doco_id, from_id, to_id, edge_type)
           *
      FROM resolved
     ORDER BY doco_id, from_id, to_id, edge_type
  ),
  to_insert AS (
    SELECT 'edge_' || upper(substr(md5(doco_id || ':' || from_id || ':' || to_id || ':' || edge_type), 1, 26)) AS id,
           *
      FROM deduped d
     WHERE NOT EXISTS (
       SELECT 1
         FROM edges e
        WHERE e.doco_id = d.doco_id
          AND e.from_id = d.from_id
          AND e.to_id = d.to_id
          AND e.edge_type = d.edge_type
          AND e.lifecycle <> 'retired'
     )
  ),
  system_changesets AS (
    INSERT INTO changesets (doco_id, source, reason, metadata)
    SELECT DISTINCT doco_id,
           'system',
           'extract node JSON relations into edge rows',
           '{"migration":"078_materialize_json_relation_edges"}'::jsonb
      FROM to_insert
    RETURNING doco_id, tx_id
  ),
  inserted_edges AS (
    INSERT INTO edges
      (id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type,
       props, lifecycle, origin, created_by, updated_by)
    SELECT id, doco_id, edge_type, from_id, from_node_type, to_id, to_node_type,
           props, 'asserted', 'authored', actor, actor
      FROM to_insert
    ON CONFLICT (id) DO NOTHING
    RETURNING *
  )
  INSERT INTO edge_versions
    (entity_id, entity_type, version, op, payload, tx_id, actor, prev_hash, this_hash)
  SELECT e.id,
         'edge',
         1,
         'create',
         to_jsonb(e),
         cs.tx_id,
         e.created_by,
         NULL,
         encode(
           digest(
             'genesis' || E'\n' ||
             e.id || E'\n' ||
             '1' || E'\n' ||
             'create' || E'\n' ||
             _doco_078_jsonb_stable(to_jsonb(e)) || E'\n' ||
             cs.tx_id::text || E'\n' ||
             COALESCE(e.created_by, ''),
             'sha256'
           ),
           'hex'
         )
    FROM inserted_edges e
    JOIN system_changesets cs ON cs.doco_id = e.doco_id
  ON CONFLICT (entity_id, version) DO NOTHING;

  WITH stripped AS (
    SELECT id,
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
             - 'parent_intent_id'
             - 'stakeholders'
             - 'template_id'
             - 'relates_to' AS next_data,
           COALESCE(data->>'owner_id', '') ~ '^(intent|decision|action|log|rule|eval|reference|state|idea|principal)_' AS strip_owner_id,
           COALESCE(data->>'decided_by', '') ~ '^(intent|decision|action|log|rule|eval|reference|state|idea|principal)_' AS strip_decided_by
      FROM nodes
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
       'owner_id',
       'parent_intent_id',
       'stakeholders',
       'decided_by',
       'template_id',
       'relates_to'
     ]
  )
  UPDATE nodes n
     SET data =
           CASE WHEN s.strip_decided_by
             THEN CASE WHEN s.strip_owner_id THEN s.next_data - 'owner_id' - 'decided_by' ELSE s.next_data - 'decided_by' END
             ELSE CASE WHEN s.strip_owner_id THEN s.next_data - 'owner_id' ELSE s.next_data END
           END,
         updated_at = now()
    FROM stripped s
   WHERE n.id = s.id;
END
$do$;

DROP FUNCTION IF EXISTS _doco_078_jsonb_stable(jsonb);
