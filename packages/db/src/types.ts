// Per-node-type table mapping + storage interface.

/**
 * Storage tables that hold the source-of-truth for each node type.
 * `body` is true if the type carries a markdown body (so the row has
 * a `body_md` column).
 */
export const NODE_TABLES: Record<string, { table: string; body: boolean }> = {
  intent: { table: "intents", body: true },
  decision: { table: "decisions", body: true },
  rule: { table: "rules", body: true },
  action: { table: "actions", body: true },
  log: { table: "logs", body: true },
  eval: { table: "evals", body: true },
  scope: { table: "scopes", body: false },
  tag: { table: "tags", body: false },
  idea: { table: "ideas", body: true },
  reference: { table: "reference_entities", body: false },
  // Per decision_01KRRR5BQ16ASY8HQEE0V499YG (v7) — State is a node in a
  // formal state machine. Prose body for description; structured
  // (`kind`, `invariants`) in frontmatter.
  state: { table: "states", body: true },
  // Identity types (host-level — same DB, separate tables)
  principal: { table: "principals", body: false },
  organization: { table: "organizations", body: false },
  doco: { table: "docos", body: false },
};

/**
 * The shape we round-trip between filesystem (YAML+MD) and Postgres
 * rows. Importers and exporters speak this shape; storage adapters
 * speak this shape; the read-path materializer rebuilds LoadedDoco
 * from this shape.
 */
export interface EntityRecord {
  id: string;
  doco_id: string;
  node_type: string;
  raw_yaml: string; // serialized frontmatter (canonical YAML)
  body_md?: string;
  /** Mirrored hot-path columns for indexes — derived from raw_yaml. */
  summary?: string | null;
  lifecycle?: string | null;
  name?: string | null; // scopes only
  created_at?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}
