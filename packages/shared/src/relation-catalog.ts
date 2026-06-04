export type RelationOwner = "from" | "to";
export type RelationCardinality = "one" | "many";

export interface RelationKindCatalogEntry {
  kind: string;
  owner: RelationOwner;
  value: RelationOwner;
  cardinality: RelationCardinality;
  acceptsProps?: readonly string[];
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
    description:
      "Broad enabling relation — one node serves, validates, or provides evidence for another. The endpoint node types carry the specific meaning (e.g. an Eval that `supports` a node tests it; a flow node that `supports` an Intent serves it).",
  }),
  constrained_by: relation({
    kind: "constrained_by",
    endpointTypes: { to: ["rule"] },
    description: "Node is constrained or guarded by a Rule.",
  }),
  attributed_to: relation({
    kind: "attributed_to",
    endpointTypes: { to: ["principal"] },
    description:
      "Attribution to a Principal — performer, owner, decider, or stakeholder. The attributing node's type carries the specific meaning (an Action's actor, an Intent's owner, a gateway Decision's decider).",
  }),
  has_parent: relation({
    kind: "has_parent",
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
      "Associative 'see also' link between two peer nodes (the SKOS `related` analogue). No hierarchy or direction implied. Glossaries use it to connect related, confusable, parent/child, or homograph terms; org charts use it to tie the multiple seats one person holds.",
  }),
} as const satisfies Record<string, RelationKindCatalogEntry>;

export type CatalogRelationKind = keyof typeof RELATION_CATALOG;

export const CATALOG_RELATION_KINDS = Object.keys(RELATION_CATALOG) as CatalogRelationKind[];

function relation(
  entry: Pick<RelationKindCatalogEntry, "kind" | "description"> &
    Partial<Omit<RelationKindCatalogEntry, "kind" | "description">>,
): RelationKindCatalogEntry {
  return {
    owner: "from",
    value: "to",
    cardinality: "many",
    ...entry,
  };
}
