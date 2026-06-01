-- 074_drop_node_ref_columns.sql — drop the five promoted node→node FK columns.
--
-- First-class edges are the authored source of truth for node→node
-- relationships:
--   parent_intent_id          → has_parent     (intent → intent)
--   decided_by                → decided_by      (decision → principal)
--   superseded_by_decision_id → superseded_by   (decision → decision)
--   actor_id                  → performed_by    (action/log → principal)
--   template_id               → templated_by    (log → action)
--
-- This reverses the node self-FK half of migration 070. The edges-endpoint FKs
-- (edges.from_id/to_id → nodes) and `proposer_id` → users(id) from 070 STAY —
-- proposer_id is an OAuth identity, not a node, so it is not a node→node edge.
--
-- DROP COLUMN cascades to the column's FK constraint and its partial indexes
-- (nodes_superseded_idx, nodes_actor_idx), so a single DROP COLUMN IF EXISTS per
-- column suffices. Idempotent + genesis-safe: guarded on `nodes` existence (on
-- a fresh bootstrap 063 has dropped `nodes` during the migration window, so this
-- no-ops and schema.sql — which no longer declares the columns — applies the
-- final shape on its second pass).

DO $do$
BEGIN
  IF to_regclass('public.nodes') IS NOT NULL THEN
    ALTER TABLE nodes DROP COLUMN IF EXISTS parent_intent_id;
    ALTER TABLE nodes DROP COLUMN IF EXISTS decided_by;
    ALTER TABLE nodes DROP COLUMN IF EXISTS superseded_by_decision_id;
    ALTER TABLE nodes DROP COLUMN IF EXISTS actor_id;
    ALTER TABLE nodes DROP COLUMN IF EXISTS template_id;
  ELSE
    RAISE NOTICE '074: nodes table absent (fresh genesis bootstrap) — schema.sql (without these columns) applies instead';
  END IF;
END
$do$;
