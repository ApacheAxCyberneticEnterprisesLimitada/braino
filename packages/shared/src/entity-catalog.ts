export interface NodeCatalogEntry {
  type: string;
  segment: string;
  storage: {
    table: "nodes";
    typeNamedColumn: "prose";
  };
  capture: "generic" | "bespoke";
  searchable: boolean;
}

export const NODE_CATALOG = {
  intent: node("intent", "intents"),
  idea: node("idea", "ideas"),
  rule: node("rule", "rules"),
  decision: node("decision", "decisions"),
  action: node("action", "actions"),
  log: node("log", "logs"),
  eval: node("eval", "evals"),
  reference: node("reference", "references"),
  state: node("state", "states"),
  // Principal is a bespoke-capture node (the /principals.json route + the
  // org-tree / BPMN-lane readers), but it carries its text in the one canonical
  // `prose` column like every other node — no `body_md`, no second text field.
  principal: {
    ...node("principal", "principals"),
    capture: "bespoke",
  },
} as const satisfies Record<string, NodeCatalogEntry>;

export type CatalogNodeType = keyof typeof NODE_CATALOG;

export const CATALOG_NODE_TYPES = Object.keys(NODE_CATALOG) as CatalogNodeType[];

export const GENERIC_CAPTURE_NODE_TYPES = CATALOG_NODE_TYPES.filter(
  (type) => NODE_CATALOG[type].capture === "generic",
);

function node(type: string, segment: string): NodeCatalogEntry {
  return {
    type,
    segment,
    storage: { table: "nodes", typeNamedColumn: "prose" },
    capture: "generic",
    searchable: true,
  };
}
