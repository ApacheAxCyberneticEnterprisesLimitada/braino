// Node→node relationships the capture path projects into first-class edges
// (option (i): edges as the authored source of truth). Each relation field on a
// node maps to an edge type. The capture path authors the edge and STRIPS the
// field from stored `data`; reads may RECONSTRUCT the field from the edge for
// compatibility callers.
//
// Single source of truth, shared by:
//   - capture authoring + the indexer's deriveEdges (@doco/index)
//   - the db read layer: strip on write + hydrate on read (@doco/db)
//   - the bpmn perspective (@doco/web)

import { EDGE_TYPES, type EdgeType } from "./access-types.js";
import { NODE_TYPES, type NodeType } from "./branded.js";

/** Edge type → the node `data` field it reconstructs on read. */
export const MANAGED_EDGE_TO_FIELD = {
  sequence_flow: "sequence_to",
  preceded_by: "preceded_by",
  serves: "intent_ids",
  enacts: "decision_ids",
  gated_by: "gated_by",
  consults: "rules_consulted",
  tests: "target_ref",
  born_from: "born_from",
  has_parent: "parent_intent_id",
  has_stakeholder: "stakeholders",
  owned_by: "owner_id",
  decided_by: "decided_by",
  superseded_by: "superseded_by",
  implemented_by: "implemented_by",
  reports_to: "reports_to",
  dotted_reports_to: "dotted_reports_to",
  same_occupant_as: "same_occupant_as",
  performed_by: "actor_id",
  templated_by: "template_id",
  relates_to: "relates_to",
} as const;

export type ManagedEdgeType = keyof typeof MANAGED_EDGE_TO_FIELD;

const _managedCoversEveryEdgeType: Record<EdgeType, string> = MANAGED_EDGE_TO_FIELD;
void _managedCoversEveryEdgeType;

export const MANAGED_EDGE_CARDINALITY: Readonly<Record<ManagedEdgeType, "one" | "many">> = {
  sequence_flow: "many",
  preceded_by: "many",
  serves: "many",
  enacts: "many",
  gated_by: "many",
  consults: "many",
  tests: "one",
  born_from: "one",
  superseded_by: "one",
  implemented_by: "many",
  reports_to: "one",
  dotted_reports_to: "many",
  same_occupant_as: "many",
  performed_by: "one",
  owned_by: "one",
  has_parent: "one",
  has_stakeholder: "many",
  decided_by: "one",
  templated_by: "one",
  relates_to: "many",
};

export const MANAGED_FIELD_TO_EDGE: Readonly<Record<string, ManagedEdgeType>> = Object.fromEntries(
  Object.entries(MANAGED_EDGE_TO_FIELD).map(([edge, field]) => [field, edge]),
) as Record<string, ManagedEdgeType>;

export const MANAGED_RELATION_FIELDS = [
  ...new Set(Object.values(MANAGED_EDGE_TO_FIELD)),
] as readonly string[];

/**
 * Node type → the relationship field(s) it owns. These are stripped from `data`
 * on write (the edge is the source of truth) and reconstructed from edges on
 * read. `proposer_id` is intentionally absent — it points at users(id), an
 * OAuth identity, not a node, so it stays a column and is not an edge.
 */
export const MANAGED_FIELDS_BY_TYPE: Readonly<Record<NodeType, readonly string[]>> =
  Object.fromEntries(NODE_TYPES.map((type) => [type, MANAGED_RELATION_FIELDS])) as Record<
    NodeType,
    readonly string[]
  >;

const _edgeTypeCoverage: readonly ManagedEdgeType[] = EDGE_TYPES;
void _edgeTypeCoverage;
