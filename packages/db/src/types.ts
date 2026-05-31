// Per-entity-type table mapping + storage interface.
//
// Post-rename (migration 005): entities are split across five categories.
// Each category maps to one or more tables; the type discriminator string
// (e.g. "intent", "guidance_policy", "user") names the row.

/**
 * The 10 node types (graph-knowledge entities).
 *
 * `typeNamedColumn`, where present, is the per-table text column that
 * holds the full prose content for that node — the destination of
 * the old `summary` + `body_md` (+ `title` on intents, + `name`/
 * `description` on evals) collapse landed by migrations 022 and 023.
 *
 * `body` reflects whether the table physically has a `body_md`
 * column. For the 9 migrated nodes it is false (prose lives in the
 * type-named column). Principal still carries name + body_md.
 */
export const NODE_TABLES: Record<
  string,
  { table: string; body: boolean; typeNamedColumn?: string }
> = {
  // Post-collapse (Proposal B): every node type lives in the unified `nodes`
  // table, discriminated by node_type. Prose is the `prose` column; `body_md`
  // exists on `nodes` (carries principals' description). The per-type tables +
  // type-named columns are gone — these fields now describe `nodes` uniformly.
  intent: { table: "nodes", body: true, typeNamedColumn: "prose" },
  idea: { table: "nodes", body: true, typeNamedColumn: "prose" },
  rule: { table: "nodes", body: true, typeNamedColumn: "prose" },
  decision: { table: "nodes", body: true, typeNamedColumn: "prose" },
  action: { table: "nodes", body: true, typeNamedColumn: "prose" },
  log: { table: "nodes", body: true, typeNamedColumn: "prose" },
  eval: { table: "nodes", body: true, typeNamedColumn: "prose" },
  reference: { table: "nodes", body: true, typeNamedColumn: "prose" },
  state: { table: "nodes", body: true, typeNamedColumn: "prose" },
  // Principal = role/persona (referenced by actor_id/actors[]), NOT the OAuth
  // user layer (that lives in `users`).
  principal: { table: "nodes", body: true, typeNamedColumn: "prose" },
};

export interface EntityTableSpec {
  table: string;
  entityType: string;
  body: boolean;
  labelExpr?: string;
  nameExpr?: string;
}

// Post-collapse: all 9 prose node types live in `nodes` (discriminated by
// entityType → node_type). Kept as a list of the graph node types consumers
// iterate; `table` is uniformly `nodes`.
export const DOCO_NODE_TABLE_SPECS: readonly EntityTableSpec[] = [
  { table: "nodes", entityType: "decision", body: true },
  { table: "nodes", entityType: "intent", body: true },
  { table: "nodes", entityType: "action", body: true },
  { table: "nodes", entityType: "log", body: true },
  { table: "nodes", entityType: "rule", body: true },
  { table: "nodes", entityType: "eval", body: true },
  { table: "nodes", entityType: "reference", body: true },
  { table: "nodes", entityType: "idea", body: true },
  { table: "nodes", entityType: "state", body: true },
] as const;

export const DOCO_NODE_TABLE_BY_TYPE: Readonly<Record<string, EntityTableSpec>> =
  Object.fromEntries(DOCO_NODE_TABLE_SPECS.map((spec) => [spec.entityType, spec]));

/**
 * Promoted columns on the unified `nodes` table, per node type. Single source
 * of truth for the storage writer (`upsertEntity` → `nodes`). Mirrors the
 * one-time copy map in migration 064.
 *
 * These are the per-type graph columns promoted out of the `data` jsonb:
 * relationship refs (each carries a foreign key again — migration 070: five
 * self-reference nodes(id); `proposer_id` → users(id)) and filterable
 * scalars. Principal's identity columns (name / body_md / role_principal)
 * are handled directly by the writer, not here.
 *
 * - `field`        — source key in the entity's `data`/frontmatter.
 * - `requirePrefix`— only persist the value when it has this id prefix
 *                    (decisions.superseded_by_decision_id is decision-only;
 *                    the frontmatter `superseded_by` is polymorphic).
 * - `stripFromData`— drop the key from the `data` jsonb after promoting, so
 *                    the typed column is the single source of truth (the
 *                    migration-035 scalars). Relationship refs are NOT
 *                    stripped (the indexer still derives edges from them).
 */
export interface PromotedColumnSpec {
  column: string;
  field: string;
  requirePrefix?: string;
  stripFromData?: boolean;
}

export const NODE_PROMOTED_COLUMNS: Readonly<Record<string, readonly PromotedColumnSpec[]>> = {
  // Node→node relationships are no longer promoted to columns — migration 074
  // dropped those columns and the capture path projects each into a first-class
  // `edges` row instead (option (i): edges as the authored source of truth).
  // intent/decision promoted only relationship refs, so they promote nothing
  // now; the authored values still live in `data`. `proposer_id` stays — it
  // points at users(id) (an OAuth identity, not a node), not a node→node edge.
  intent: [],
  idea: [{ column: "proposer_id", field: "proposer_id" }],
  decision: [],
  action: [
    { column: "verb", field: "verb", stripFromData: true },
    { column: "performed_at", field: "performed_at", stripFromData: true },
  ],
  log: [
    { column: "verb", field: "verb", stripFromData: true },
    { column: "happened_at", field: "happened_at", stripFromData: true },
  ],
  eval: [{ column: "kind", field: "kind", stripFromData: true }],
  rule: [
    { column: "modality", field: "modality", stripFromData: true },
    { column: "severity", field: "severity", stripFromData: true },
    { column: "phase", field: "phase", stripFromData: true },
    { column: "on_violation", field: "on_violation", stripFromData: true },
  ],
  state: [{ column: "kind", field: "kind", stripFromData: true }],
  reference: [
    { column: "ref_type", field: "ref_type", stripFromData: true },
    { column: "locator", field: "locator", stripFromData: true },
    { column: "citation", field: "citation", stripFromData: true },
    { column: "title", field: "title", stripFromData: true },
  ],
  // principal: no graph promoted columns; name/body_md/role_principal handled
  // directly by the writer (role_principal is stripped from data there).
};

/** The 2 policy types. Policies are always Doco-scoped. */
export const POLICY_TABLES: Record<string, { table: string; body: boolean }> = {
  guidance_policy: {
    table: "guidance_policies",
    body: true,
  },
  node_authoring_policy: {
    table: "node_authoring_policies",
    body: true,
  },
};

/** The user category — OAuth identity layer. One table, two kinds. */
export const USER_TABLES: Record<string, { table: string; body: boolean }> = {
  user: { table: "users", body: false },
};

/** Containers — docos and organizations are their own top-level categories. */
export const CONTAINER_TABLES: Record<string, { table: string; body: boolean }> = {
  doco: { table: "docos", body: false },
  organization: { table: "organizations", body: false },
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
  // Policies are flattened to their per-Doco table here; org-scope
  // policies are addressed by their separate org table in callers that
  // care.
  guidance_policy: { table: "guidance_policies", body: true },
  node_authoring_policy: { table: "node_authoring_policies", body: true },
};

/**
 * The shape we round-trip between filesystem (YAML+MD) and Postgres
 * rows. Importers and exporters speak this shape; storage adapters
 * speak this shape; the read-path materializer rebuilds LoadedDoco
 * from this shape.
 *
 * `entity_type` carries the discriminator string across all categories:
 * 10 node types + 2 policy kinds + user + doco + organization. The field
 * was named `node_type` pre-migration-005.
 */
export interface EntityRecord {
  id: string;
  doco_id: string;
  entity_type: string;
  /** Bag of structured fields. Stored as `data jsonb` in Postgres;
   *  node-pg parses jsonb columns to JS objects on read. */
  data: Record<string, unknown>;
  body_md?: string;
  /** Mirrored hot-path columns for indexes — derived from data. */
  summary?: string | null;
  lifecycle?: string | null;
  name?: string | null;
  /**
   * Migration-022 type-named column — `intent` for intent rows,
   * `decision` for decision rows, etc. Holds the full prose content
   * for the node once the rename completes. During the additive
   * window this carries the same content as `summary` (+ optional
   * `body_md` and type-specific extras, merged at backfill time).
   */
  type_named_value?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}
