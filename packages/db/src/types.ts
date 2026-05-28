// Per-entity-type table mapping + storage interface.
//
// Post-rename (migration 005): entities are split across five categories.
// Each category maps to one or more tables; the type discriminator string
// (e.g. "intent", "guidance_policy", "user") names the row.

/**
 * The 10 neuron types (graph-knowledge entities).
 *
 * `typeNamedColumn`, where present, is the per-table text column that
 * holds the full prose content for that neuron — the destination of
 * the old `summary` + `body_md` (+ `title` on intents, + `name`/
 * `description` on evals) collapse landed by migrations 022 and 023.
 *
 * `body` reflects whether the table physically has a `body_md`
 * column. For the 9 migrated neurons it is false (prose lives in the
 * type-named column). Principal still carries name + body_md.
 */
export const NEURON_TABLES: Record<
  string,
  { table: string; body: boolean; typeNamedColumn?: string }
> = {
  intent: { table: "intents", body: false, typeNamedColumn: "intent" },
  idea: { table: "ideas", body: false, typeNamedColumn: "idea" },
  rule: { table: "rules", body: false, typeNamedColumn: "rule" },
  decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
  action: { table: "actions", body: false, typeNamedColumn: "action" },
  log: { table: "logs", body: false, typeNamedColumn: "log" },
  eval: { table: "evals", body: false, typeNamedColumn: "eval" },
  reference: { table: "reference_entities", body: false, typeNamedColumn: "reference" },
  state: { table: "states", body: false, typeNamedColumn: "state" },
  // Principal = documented role/persona, referenced by actor_id/actors[].
  // NOT the OAuth identity layer — that lives in users.
  // body_md carries prose description of the role. Principal is
  // intentionally excluded from the type-named-column rename for now.
  principal: { table: "principals", body: true },
};

export interface EntityTableSpec {
  table: string;
  entityType: string;
  body: boolean;
  labelExpr?: string;
  nameExpr?: string;
}

export const DOCO_NEURON_TABLE_SPECS: readonly EntityTableSpec[] = [
  { table: "decisions", entityType: "decision", body: false },
  { table: "intents", entityType: "intent", body: false },
  { table: "actions", entityType: "action", body: false },
  { table: "logs", entityType: "log", body: false },
  { table: "rules", entityType: "rule", body: false },
  { table: "evals", entityType: "eval", body: false },
  { table: "reference_entities", entityType: "reference", body: false },
  { table: "ideas", entityType: "idea", body: false },
  { table: "states", entityType: "state", body: false },
] as const;

export const DOCO_NEURON_TABLE_BY_TYPE: Readonly<Record<string, EntityTableSpec>> =
  Object.fromEntries(DOCO_NEURON_TABLE_SPECS.map((spec) => [spec.entityType, spec]));

/** The 2 policy types. Policies are always Doco-scoped. */
export const POLICY_TABLES: Record<string, { table: string; body: boolean }> = {
  guidance_policy: {
    table: "guidance_policies",
    body: true,
  },
  neuron_authoring_policy: {
    table: "neuron_authoring_policies",
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

/** Auxiliary entity (tags): used for organization, not in any of the five categories. */
export const AUX_TABLES: Record<string, { table: string; body: boolean }> = {
  tag: { table: "tags", body: false },
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
  ...NEURON_TABLES,
  ...USER_TABLES,
  ...CONTAINER_TABLES,
  ...AUX_TABLES,
  // Policies are flattened to their per-Doco table here; org-scope
  // policies are addressed by their separate org table in callers that
  // care.
  guidance_policy: { table: "guidance_policies", body: true },
  neuron_authoring_policy: { table: "neuron_authoring_policies", body: true },
};

/**
 * The shape we round-trip between filesystem (YAML+MD) and Postgres
 * rows. Importers and exporters speak this shape; storage adapters
 * speak this shape; the read-path materializer rebuilds LoadedDoco
 * from this shape.
 *
 * `entity_type` carries the discriminator string (one of 14 values
 * across all categories: 10 neurons + 2 policies + 1 user +
 * doco + organization, plus the auxiliary "tag"). The field was named
 * `node_type` pre-migration-005.
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
   * for the neuron once the rename completes. During the additive
   * window this carries the same content as `summary` (+ optional
   * `body_md` and type-specific extras, merged at backfill time).
   */
  type_named_value?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}
