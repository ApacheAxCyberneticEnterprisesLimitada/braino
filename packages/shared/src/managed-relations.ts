// Node→node relationships the capture path projects into first-class edges
// (option (i): edges as the authored source of truth). Each scalar field on a
// node maps 1:1 to an edge type. The capture path authors the edge and STRIPS
// the field from stored `data`; reads RECONSTRUCT the field from the edge.
//
// Single source of truth, shared by:
//   - capture authoring + the indexer's deriveEdges (@doco/index)
//   - the db read layer: strip on write + hydrate on read (@doco/db)
//   - the bpmn perspective (@doco/web)

/** Edge type → the node `data` field it reconstructs on read. */
export const MANAGED_EDGE_TO_FIELD = {
  has_parent: "parent_intent_id",
  decided_by: "decided_by",
  superseded_by: "superseded_by",
  performed_by: "actor_id",
  templated_by: "template_id",
} as const;

export type ManagedEdgeType = keyof typeof MANAGED_EDGE_TO_FIELD;

/**
 * Node type → the relationship field(s) it owns. These are stripped from `data`
 * on write (the edge is the source of truth) and reconstructed from edges on
 * read. `proposer_id` is intentionally absent — it points at users(id), an
 * OAuth identity, not a node, so it stays a column and is not an edge.
 */
export const MANAGED_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  intent: ["parent_intent_id"],
  decision: ["decided_by", "superseded_by"],
  action: ["actor_id"],
  log: ["actor_id", "template_id"],
};
