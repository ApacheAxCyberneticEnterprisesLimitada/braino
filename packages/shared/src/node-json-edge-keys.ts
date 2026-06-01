// Field names that would encode graph links inside node JSON. Graph links are
// first-class edge rows only.

export const BLOCKED_NODE_JSON_EDGE_FIELDS = [
  "sequence_to",
  "preceded_by",
  "intent_ids",
  "decision_ids",
  "gated_by",
  "rules_consulted",
  "target_ref",
  "born_from",
  "superseded_by",
  "implemented_by",
  "reports_to",
  "dotted_reports_to",
  "same_occupant_as",
  "actor_id",
  "actor_principal_id",
  "actors",
  "actors_principal_ids",
  "wanted_by",
  "wanted_by_principal_id",
  "owner_id",
  "decided_by",
  "decided_by_principal_id",
  "authored_by",
  "authored_by_principal_id",
  "created_by_principal_id",
  "parent_intent_id",
  "stakeholders",
  "stakeholders_principal_ids",
  "template_id",
  "relates_to",
] as const;

export type BlockedNodeJsonEdgeField = (typeof BLOCKED_NODE_JSON_EDGE_FIELDS)[number];

export const BLOCKED_NODE_JSON_EDGE_FIELD_SET: ReadonlySet<string> = new Set(
  BLOCKED_NODE_JSON_EDGE_FIELDS,
);
