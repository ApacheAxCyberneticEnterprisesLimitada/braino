// Node-to-node relationship fields the capture path projects into first-class
// edges. The public edge vocabulary is intentionally small; field-specific
// meaning is preserved as edge props (`source_field` + `role`) so old authoring
// inputs can keep working while writes are gateable by canonical edge family.

import { EDGE_TYPES, type EdgeType } from "./access-types.js";
import { NODE_TYPES, type NodeType } from "./branded.js";

export type RelationCardinality = "one" | "many";

export interface ManagedRelationFieldSpec {
  edgeType: EdgeType;
  cardinality: RelationCardinality;
  role: string;
  owners?: readonly NodeType[];
}

export const MANAGED_RELATION_FIELD_SPECS = {
  sequence_to: { edgeType: "flows_to", cardinality: "many", role: "sequence" },
  preceded_by: { edgeType: "flows_to", cardinality: "many", role: "predecessor" },

  intent_ids: { edgeType: "supports", cardinality: "many", role: "serves" },
  decision_ids: { edgeType: "supports", cardinality: "many", role: "enacts" },
  target_ref: {
    edgeType: "supports",
    cardinality: "one",
    role: "tests",
    owners: ["eval", "reference"],
  },
  implemented_by: { edgeType: "supports", cardinality: "many", role: "implemented_by" },

  gated_by: { edgeType: "constrained_by", cardinality: "many", role: "gated_by" },
  rules_consulted: {
    edgeType: "constrained_by",
    cardinality: "many",
    role: "consults",
  },

  actor_id: { edgeType: "attributed_to", cardinality: "one", role: "performed_by" },
  owner_id: { edgeType: "attributed_to", cardinality: "one", role: "owned_by" },
  stakeholders: { edgeType: "attributed_to", cardinality: "many", role: "has_stakeholder" },
  decided_by: { edgeType: "attributed_to", cardinality: "one", role: "decided_by" },

  parent_intent_id: { edgeType: "has_parent", cardinality: "one", role: "parent_intent" },
  reports_to: {
    edgeType: "has_parent",
    cardinality: "one",
    role: "reports_to",
    owners: ["principal"],
  },
  dotted_reports_to: {
    edgeType: "has_parent",
    cardinality: "many",
    role: "dotted_reports_to",
    owners: ["principal"],
  },

  born_from: { edgeType: "derived_from", cardinality: "one", role: "born_from" },
  template_id: { edgeType: "derived_from", cardinality: "one", role: "templated_by" },

  superseded_by: { edgeType: "replaces", cardinality: "one", role: "superseded_by" },

  relates_to: { edgeType: "relates_to", cardinality: "many", role: "relates_to" },
  same_occupant_as: {
    edgeType: "relates_to",
    cardinality: "many",
    role: "same_occupant_as",
    owners: ["principal"],
  },
} as const satisfies Record<string, ManagedRelationFieldSpec>;

export type ManagedRelationField = keyof typeof MANAGED_RELATION_FIELD_SPECS;
export type ManagedEdgeType = EdgeType;

const MANAGED_EDGE_TYPE_SET = new Set<EdgeType>(
  Object.values(MANAGED_RELATION_FIELD_SPECS).map((spec) => spec.edgeType),
);

export const MANAGED_EDGE_TYPES = EDGE_TYPES.filter((edgeType) =>
  MANAGED_EDGE_TYPE_SET.has(edgeType),
) as readonly ManagedEdgeType[];

const _managedCoversEveryEdgeType: Record<EdgeType, true> = {
  flows_to: true,
  supports: true,
  constrained_by: true,
  attributed_to: true,
  has_parent: true,
  derived_from: true,
  replaces: true,
  relates_to: true,
};
void _managedCoversEveryEdgeType;

export const MANAGED_FIELD_TO_EDGE: Readonly<Record<ManagedRelationField, EdgeType>> =
  Object.fromEntries(
    Object.entries(MANAGED_RELATION_FIELD_SPECS).map(([field, spec]) => [field, spec.edgeType]),
  ) as Record<ManagedRelationField, EdgeType>;

export const MANAGED_RELATION_FIELDS = Object.keys(
  MANAGED_RELATION_FIELD_SPECS,
) as readonly ManagedRelationField[];

/**
 * Compatibility names for older call sites. These are canonical edge family
 * defaults only; hydrate via field/role helpers when the exact field matters.
 */
export const MANAGED_EDGE_TO_FIELD = {
  flows_to: "sequence_to",
  supports: "supports",
  constrained_by: "gated_by",
  attributed_to: "actor_id",
  has_parent: "parent_intent_id",
  derived_from: "born_from",
  replaces: "superseded_by",
  relates_to: "relates_to",
} as const satisfies Record<EdgeType, string>;

export const MANAGED_EDGE_CARDINALITY = {
  flows_to: "many",
  supports: "many",
  constrained_by: "many",
  attributed_to: "many",
  has_parent: "many",
  derived_from: "many",
  replaces: "one",
  relates_to: "many",
} as const satisfies Record<EdgeType, RelationCardinality>;

/**
 * Node type -> the relationship field(s) it owns. These are stripped from
 * `data` on write (the edge is the source of truth) and reconstructed from
 * edges on read. `proposer_id` is intentionally absent: it points at users(id),
 * an OAuth identity, not a node.
 */
export const MANAGED_FIELDS_BY_TYPE: Readonly<Record<NodeType, readonly string[]>> =
  Object.fromEntries(NODE_TYPES.map((type) => [type, MANAGED_RELATION_FIELDS])) as Record<
    NodeType,
    readonly string[]
  >;

export function managedRelationSpecForField(
  field: string,
): (ManagedRelationFieldSpec & { field: ManagedRelationField }) | null {
  if (!isManagedRelationField(field)) return null;
  return { field, ...MANAGED_RELATION_FIELD_SPECS[field] };
}

export function isManagedRelationField(field: string): field is ManagedRelationField {
  return field in MANAGED_RELATION_FIELD_SPECS;
}

export function managedEdgePropsForField(
  field: string,
  props?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const spec = managedRelationSpecForField(field);
  if (!spec) return props;
  return { ...(props ?? {}), role: spec.role, source_field: field };
}

export function fieldForManagedEdge(
  edgeType: string,
  props: Record<string, unknown> | null | undefined,
): ManagedRelationField | null {
  const sourceField = typeof props?.source_field === "string" ? props.source_field : null;
  if (sourceField && isManagedRelationField(sourceField)) {
    const spec = MANAGED_RELATION_FIELD_SPECS[sourceField];
    if (spec.edgeType === edgeType) return sourceField;
  }

  const role = typeof props?.role === "string" ? props.role : null;
  if (role) {
    for (const [field, spec] of Object.entries(MANAGED_RELATION_FIELD_SPECS)) {
      if (spec.edgeType === edgeType && spec.role === role) return field as ManagedRelationField;
    }
  }

  return null;
}

export function cardinalityForManagedField(field: ManagedRelationField): RelationCardinality {
  return MANAGED_RELATION_FIELD_SPECS[field].cardinality;
}

export function stripManagedEdgeProps(
  props: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(props ?? {}).filter(([key]) => key !== "role" && key !== "source_field"),
  );
}
