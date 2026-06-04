export interface NodeCatalogEntry {
  type: string;
  segment: string;
  proseField: string;
  labelField: string;
  storage: {
    table: "nodes";
    body: boolean;
    typeNamedColumn: "prose";
  };
  capture: "generic" | "bespoke";
  searchable: boolean;
}

export const NODE_CATALOG = {
  intent: node("intent", "intents", "intent"),
  idea: node("idea", "ideas", "idea"),
  rule: node("rule", "rules", "rule"),
  decision: node("decision", "decisions", "decision"),
  action: node("action", "actions", "action"),
  log: node("log", "logs", "log"),
  eval: node("eval", "evals", "eval"),
  reference: node("reference", "references", "reference"),
  state: node("state", "states", "state"),
  principal: {
    ...node("principal", "principals", "body_md"),
    labelField: "name",
    capture: "bespoke",
  },
} as const satisfies Record<string, NodeCatalogEntry>;

export type CatalogNodeType = keyof typeof NODE_CATALOG;

export const CATALOG_NODE_TYPES = Object.keys(NODE_CATALOG) as CatalogNodeType[];

export const GENERIC_CAPTURE_NODE_TYPES = CATALOG_NODE_TYPES.filter(
  (type) => NODE_CATALOG[type].capture === "generic",
);

function node(type: string, segment: string, proseField: string): NodeCatalogEntry {
  return {
    type,
    segment,
    proseField,
    labelField: proseField,
    storage: { table: "nodes", body: false, typeNamedColumn: "prose" },
    capture: "generic",
    searchable: true,
  };
}
