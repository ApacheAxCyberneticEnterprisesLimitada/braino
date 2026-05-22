// Per-entity-type table mapping + storage interface.
//
// Post-rename (migration 005): entities are split across five categories.
// Each category maps to one or more tables; the type discriminator string
// (e.g. "intent", "guidance_primitive", "collaborator") names the row.

/** The 10 neuron types (graph-knowledge entities). */
export const NEURON_TABLES: Record<string, { table: string; body: boolean }> = {
  intent: { table: "intents", body: true },
  idea: { table: "ideas", body: true },
  rule: { table: "rules", body: true },
  decision: { table: "decisions", body: true },
  action: { table: "actions", body: true },
  log: { table: "logs", body: true },
  eval: { table: "evals", body: true },
  reference: { table: "reference_entities", body: false },
  state: { table: "states", body: true },
  // Principal = documented role/persona, referenced by actor_id/actors[].
  // NOT the OAuth identity layer — that lives in collaborators.
  // body_md carries prose description of the role.
  principal: { table: "principals", body: true },
};

/** The 2 primitive types (constitution metadata). Per-Doco and per-org variants. */
export const PRIMITIVE_TABLES: Record<string, { docoTable: string; orgTable: string; body: boolean }> = {
  guidance_primitive: {
    docoTable: "guidance_primitives",
    orgTable: "org_guidance_primitives",
    body: true,
  },
  neuron_authoring_primitive: {
    docoTable: "neuron_authoring_primitives",
    orgTable: "org_neuron_authoring_primitives",
    body: true,
  },
};

/** The collaborator category — OAuth identity layer. One table, two kinds. */
export const COLLABORATOR_TABLES: Record<string, { table: string; body: boolean }> = {
  collaborator: { table: "collaborators", body: false },
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
export const ALL_ENTITY_TABLES: Record<string, { table: string; body: boolean }> = {
  ...NEURON_TABLES,
  ...COLLABORATOR_TABLES,
  ...CONTAINER_TABLES,
  ...AUX_TABLES,
  // Primitives are flattened to their per-Doco table here; org-scope
  // primitives are addressed by their separate org table in callers that
  // care.
  guidance_primitive: { table: "guidance_primitives", body: true },
  neuron_authoring_primitive: { table: "neuron_authoring_primitives", body: true },
};

/**
 * The shape we round-trip between filesystem (YAML+MD) and Postgres
 * rows. Importers and exporters speak this shape; storage adapters
 * speak this shape; the read-path materializer rebuilds LoadedDoco
 * from this shape.
 *
 * `entity_type` carries the discriminator string (one of 14 values
 * across all categories: 10 neurons + 2 primitives + 1 collaborator +
 * doco + organization, plus the auxiliary "tag"). The field was named
 * `node_type` pre-migration-005.
 */
export interface EntityRecord {
  id: string;
  doco_id: string;
  entity_type: string;
  raw_yaml: string;
  body_md?: string;
  /** Mirrored hot-path columns for indexes — derived from raw_yaml. */
  summary?: string | null;
  lifecycle?: string | null;
  name?: string | null;
  created_at?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
  updated_by?: string | null;
}
