export type RelationOwner = "from" | "to";
export type RelationCardinality = "one" | "many";

export interface RelationKindCatalogEntry {
  kind: string;
  owner: RelationOwner;
  value: RelationOwner;
  cardinality: RelationCardinality;
  acceptsProps?: readonly string[];
  roleExamples?: readonly string[];
  endpointTypes?: {
    from?: readonly string[];
    to?: readonly string[];
  };
  description: string;
}

export const RELATION_CATALOG = {
  flows_to: relation({
    kind: "flows_to",
    acceptsProps: ["label", "condition", "kind"],
    description: "Forward ordered flow between process nodes.",
  }),
  supports: relation({
    kind: "supports",
    roleExamples: ["serves", "enacts", "tests", "implemented_by"],
    description:
      "Broad enabling relation, optionally role-tagged as serves, enacts, tests, or implemented_by.",
  }),
  constrained_by: relation({
    kind: "constrained_by",
    roleExamples: ["gated_by", "consults"],
    endpointTypes: { to: ["rule"] },
    description: "Node is constrained by Rules, optionally role-tagged as gated_by or consults.",
  }),
  attributed_to: relation({
    kind: "attributed_to",
    roleExamples: ["performed_by", "owned_by", "decided_by"],
    endpointTypes: { to: ["principal"] },
    description: "Principal attribution for performers, owners, stakeholders, and decision makers.",
  }),
  has_parent: relation({
    kind: "has_parent",
    roleExamples: ["parent_intent", "reports_to", "dotted_reports_to"],
    description: "Hierarchy relation for Intent nesting and Principal reporting lines.",
  }),
  derived_from: relation({
    kind: "derived_from",
    description: "Provenance relation for source material and templates.",
  }),
  replaces: relation({
    kind: "replaces",
    cardinality: "one",
    description: "Replacement or supersession relation.",
  }),
  relates_to: relation({
    kind: "relates_to",
    description:
      "Associative 'see also' link between two peer nodes (the SKOS `related` analogue). No hierarchy or direction implied. Glossaries use it to connect related, confusable, parent/child, or homograph terms.",
  }),
} as const satisfies Record<string, RelationKindCatalogEntry>;

export type CatalogRelationKind = keyof typeof RELATION_CATALOG;

export const CATALOG_RELATION_KINDS = Object.keys(RELATION_CATALOG) as CatalogRelationKind[];

function relation(
  entry: Pick<RelationKindCatalogEntry, "kind" | "description"> &
    Partial<Omit<RelationKindCatalogEntry, "kind" | "description">>,
): RelationKindCatalogEntry {
  // A relation that documents role examples MUST also accept a `role` prop.
  // Otherwise the changeset relate path (relationProps) filters `role` out as
  // an unknown prop and writes a role-less edge — which fails the role-aware
  // authoring policies and gets duplicated by a second, role-bearing edge
  // created through the direct edges route to satisfy the policy.
  const acceptsProps = entry.roleExamples
    ? ["role", ...(entry.acceptsProps ?? [])]
    : entry.acceptsProps;
  return {
    owner: "from",
    value: "to",
    cardinality: "many",
    ...entry,
    ...(acceptsProps ? { acceptsProps } : {}),
  };
}
