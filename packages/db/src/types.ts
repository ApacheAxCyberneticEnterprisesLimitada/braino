import { GENERIC_CAPTURE_NODE_TYPES, NODE_CATALOG, NODE_TYPES } from "@doco/shared";

// Per-entity-type table mapping + storage interface.
//
// Entities are split across categories. Each category maps to one or more
// tables; the type discriminator string (e.g. "intent", "policy",
// "user") names the row.

/**
 * The 10 node types (graph-knowledge entities).
 *
 * `typeNamedColumn`, where present, is the per-table text column that
 * holds the full prose content for that node.
 *
 * `body` is legacy and always false: no node carries a separate body
 * column — a node's text is its single `prose` column.
 */
export const NODE_TABLES: Record<
  string,
  { table: string; body: boolean; typeNamedColumn?: string }
> = Object.fromEntries(
  NODE_TYPES.map((type) => {
    const storage = NODE_CATALOG[type].storage;
    return [
      type,
      {
        table: storage.table,
        body: storage.body,
        typeNamedColumn: storage.typeNamedColumn,
      },
    ];
  }),
);

export interface EntityTableSpec {
  table: string;
  entityType: string;
  body: boolean;
  labelExpr?: string;
  nameExpr?: string;
}

// All node types live in `nodes` (discriminated by entityType →
// node_type). Principals are included because they are graph nodes.
export const DOCO_NODE_TABLE_SPECS: readonly EntityTableSpec[] = NODE_TYPES.map((type) => ({
  table: NODE_CATALOG[type].storage.table,
  entityType: type,
  body: NODE_CATALOG[type].storage.body,
}));

// Generic capture nodes only. Use this when a surface intentionally wants
// `/api/<plural>.json` prose captures and not bespoke Principal endpoints.
export const DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS: readonly EntityTableSpec[] =
  GENERIC_CAPTURE_NODE_TYPES.map((type) => ({
    table: NODE_CATALOG[type].storage.table,
    entityType: type,
    body: NODE_CATALOG[type].storage.body,
  }));

export const DOCO_NODE_TABLE_BY_TYPE: Readonly<Record<string, EntityTableSpec>> =
  Object.fromEntries(DOCO_NODE_TABLE_SPECS.map((spec) => [spec.entityType, spec]));

/**
 * Promoted columns on the unified `nodes` table, per node type. Single source
 * of truth for the storage writer (`upsertEntity` → `nodes`).
 *
 * These are the per-type graph columns promoted out of the `data` jsonb:
 * `proposer_id` and filterable scalars. A principal's name lands in the
 * shared `prose` column (written directly by the writer), not here.
 *
 * - `field`        — source key in the entity's `data`/frontmatter.
 * - `requirePrefix`— only persist the value when it has this id prefix
 *                    (decisions.superseded_by_decision_id is decision-only;
 *                    the frontmatter `superseded_by` is polymorphic).
 * - `stripFromData`— drop the key from the `data` jsonb after promoting, so
 *                    the typed column is the single source of truth.
 */
export interface PromotedColumnSpec {
  column: string;
  field: string;
  requirePrefix?: string;
  stripFromData?: boolean;
}

export const NODE_PROMOTED_COLUMNS: Readonly<Record<string, readonly PromotedColumnSpec[]>> = {
  // Node→node relationships are no longer promoted to columns or stored in
  // node JSON. They are first-class `edges` rows only. `proposer_id` stays: it
  // points at users(id) (an OAuth identity, not a node), not a node→node edge.
  intent: [],
  idea: [{ column: "proposer_id", field: "proposer_id" }],
  decision: [],
  // Node-shape slim-down (contract phase): action/log/rule scalars no longer
  // get their own columns — they live in the unified `extra` bag. Only
  // `kind` (eval/state) stays promoted, plus idea's `proposer_id` FK.
  action: [],
  log: [],
  eval: [{ column: "kind", field: "kind", stripFromData: true }],
  rule: [],
  state: [{ column: "kind", field: "kind", stripFromData: true }],
  // `locator` is the reference dedup key — promoted to its own typed column (the
  // remaining reference scalars stay in `extra` until Slice C drops them).
  reference: [{ column: "locator", field: "locator", stripFromData: true }],
  // principal: `kind` (human/agent) is promoted to its column; its name lands
  // in the shared `prose` column (written directly by the writer).
  principal: [{ column: "kind", field: "kind", stripFromData: true }],
};

/** The user category — human OAuth identity layer. */
export const USER_TABLES: Record<string, { table: string; body: boolean }> = {
  user: { table: "users", body: false },
};

/** Containers — docos and workspaces are their own top-level categories. */
export const CONTAINER_TABLES: Record<string, { table: string; body: boolean }> = {
  doco: { table: "docos", body: false },
  workspace: { table: "workspaces", body: false },
};

/**
 * Single lookup table covering every entity type by discriminator string.
 * Used when callers don't need to distinguish the category (audit log,
 * generic ID parser, etc.).
 */
export const ALL_ENTITY_TABLES: Record<
  string,
  { table: string; body: boolean; typeNamedColumn?: string }
> = {
  ...NODE_TABLES,
  ...USER_TABLES,
  ...CONTAINER_TABLES,
  // Policies all live in the single per-Doco `policies` table.
  policy: { table: "policies", body: false },
};

/**
 * The shape we round-trip between filesystem (YAML+MD) and Postgres
 * rows. Importers and exporters speak this shape; storage adapters
 * speak this shape; the read path rebuilds LoadedDoco
 * from this shape.
 *
 * `entity_type` carries the discriminator string across all categories:
 * 10 node types + policy + user + doco + workspace.
 */
export interface EntityRecord {
  id: string;
  doco_id: string;
  entity_type: string;
  /** Bag of structured fields. Stored as `data jsonb` in Postgres;
   *  node-pg parses jsonb columns to JS objects on read. */
  data: Record<string, unknown>;
  /** Mirrored hot-path columns for indexes — derived from data. */
  summary?: string | null;
  lifecycle?: string | null;
  name?: string | null;
  /** Node-shape slim-down: the unified per-node extra bag (jsonb). */
  extra?: Record<string, unknown> | null;
  created_at?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}
