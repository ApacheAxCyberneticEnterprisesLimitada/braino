-- 077_materialize_bpmn_sequence_edges.sql — move BPMN/process ordering out of
-- node JSON and into first-class edges.
--
-- Legacy nodes may still carry:
--   sequence_to[] → sequence_flow edge (source node → target node), preserving
--                   label/condition/kind props on edges.props.
--   preceded_by[] → preceded_by edge (later node → predecessor node), matching
--                   the historical edge_type direction.
--
-- Idempotent: skips any existing live edge with the same (doco, from, to, type)
-- and then strips the legacy JSON keys from nodes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION _doco_077_jsonb_stable(value jsonb)
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
      SELECT string_agg(_doco_077_jsonb_stable(elem), ',' ORDER BY ord)
        FROM jsonb_array_elements(value) WITH ORDINALITY AS a(elem, ord)
    ), '') || ']'
    WHEN 'object' THEN '{' || COALESCE((
      SELECT string_agg(to_jsonb(key)::text || ':' || _doco_077_jsonb_stable(value -> key), ',' ORDER BY key)
        FROM jsonb_object_keys(value) AS key
    ), '') || '}'
  END
$$;

DO $do$
BEGIN
  IF to_regclass('public.nodes') IS NULL OR to_regclass('public.edges') IS NULL THEN
    RAISE NOTICE '077: nodes/edges tables absent — schema.sql applies the final shape';
    RETURN;
  END IF;

  WITH sequence_candidates AS (
    SELECT n.doco_id,
           n.id AS from_id,
           n.node_type AS from_node_type,
           target.id AS to_id,
           target.node_type AS to_node_type,
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
        CASE
          WHEN jsonb_typeof(n.data->'sequence_to') = 'array' THEN n.data->'sequence_to'
          ELSE '[]'::jsonb
        END
      ) AS entry(value)
      JOIN nodes target
        ON target.doco_id = n.doco_id
       AND target.id = CASE
         WHEN jsonb_typeof(entry.value) = 'string' THEN entry.value #>> '{}'
         WHEN jsonb_typeof(entry.value) = 'object' THEN entry.value->>'target'
         ELSE NULL
       END
     WHERE COALESCE(n.lifecycle, 'asserted') <> 'retired'
       AND COALESCE(target.lifecycle, 'asserted') <> 'retired'
  ),
  preceded_candidates AS (
    SELECT n.doco_id,
           n.id AS from_id,
           n.node_type AS from_node_type,
           predecessor.id AS to_id,
           predecessor.node_type AS to_node_type,
           'preceded_by'::text AS edge_type,
           NULL::jsonb AS props,
           COALESCE(n.updated_by, n.created_by) AS actor
      FROM nodes n
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(n.data->'preceded_by') = 'array' THEN n.data->'preceded_by'
          ELSE '[]'::jsonb
        END
      ) AS predecessor_ref(id)
      JOIN nodes predecessor
        ON predecessor.doco_id = n.doco_id
       AND predecessor.id = predecessor_ref.id
     WHERE COALESCE(n.lifecycle, 'asserted') <> 'retired'
       AND COALESCE(predecessor.lifecycle, 'asserted') <> 'retired'
  ),
  candidates AS (
    SELECT * FROM sequence_candidates
    UNION ALL
    SELECT * FROM preceded_candidates
  ),
  deduped AS (
    SELECT DISTINCT ON (doco_id, from_id, to_id, edge_type)
           *
      FROM candidates
     WHERE from_id <> to_id
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
           'materialize BPMN sequence fields as edges',
           '{"migration":"077_materialize_bpmn_sequence_edges"}'::jsonb
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
             _doco_077_jsonb_stable(to_jsonb(e)) || E'\n' ||
             cs.tx_id::text || E'\n' ||
             COALESCE(e.created_by, ''),
             'sha256'
           ),
           'hex'
         )
    FROM inserted_edges e
    JOIN system_changesets cs ON cs.doco_id = e.doco_id
  ON CONFLICT (entity_id, version) DO NOTHING;

  UPDATE nodes
     SET data = data - 'sequence_to' - 'preceded_by',
         updated_at = now()
   WHERE data ?| ARRAY['sequence_to', 'preceded_by'];
END
$do$;

DROP FUNCTION IF EXISTS _doco_077_jsonb_stable(jsonb);
