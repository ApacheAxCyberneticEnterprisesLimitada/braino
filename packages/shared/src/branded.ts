import { CATALOG_NODE_TYPES } from "./entity-catalog.js";

/**
 * Branded ID + discriminator types — nominal-style typing so we can't
 * accidentally pass a raw string where an EntityId is expected.
 *
 * Entities are split across five categories.
 *   - Nodes (10):       graph-knowledge entities
 *   - Policies (2):       Doco-level authoring metadata
 *   - User (1):   OAuth identity layer
 *   - Doco (1):           workspace container
 *   - Workspace (1):   workspace container
 *
 * `EntityType` is the union of all 14 discriminator strings; `NodeType`
 * and `PolicyType` are the narrower types for code that wants to
 * statically prohibit cross-category misuse.
 */

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type Ulid = Brand<string, "Ulid">;

/**
 * URL handle for a Doco — the value at the start of `/<handle>/...`.
 * Callers should accept `DocoHandle` over plain `string` at API
 * boundaries to prevent passing arbitrary strings where a handle is
 * expected.
 */
export type DocoHandle = Brand<string, "DocoHandle">;

/** URL handle for an Workspace — the segment after `/workspaces/`. */
export type WorkspaceHandle = Brand<string, "WorkspaceHandle">;

/** The 10 node types — graph-knowledge entities. */
export const NODE_TYPES = CATALOG_NODE_TYPES;

export type NodeType = (typeof NODE_TYPES)[number];

/** The 2 policy types — Doco-level authoring metadata, not on the graph. */
export const POLICY_TYPES = ["guidance_policy", "node_authoring_policy"] as const;

export type PolicyType = (typeof POLICY_TYPES)[number];

/** The user type — human OAuth identity. */
export const USER_TYPE = "user" as const;
export type UserType = typeof USER_TYPE;

/** The container types — docos and workspaces. */
export const CONTAINER_TYPES = ["doco", "workspace"] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

/**
 * The edge entity type. Edges are first-class peers of nodes: their id is
 * `edge_<ulid>`. The relationship family (`supports`, `flows_to`, etc.) is a
 * separate `edge_type` sub-classification — see EDGE_TYPES in access-types.
 */
export const EDGE_ID_TYPE = "edge" as const;
export type EdgeEntityType = typeof EDGE_ID_TYPE;

/**
 * The union of every entity-type discriminator. Surfaces that genuinely
 * accept any entity (audit log, generic ID parser, search index) take
 * `EntityType`; surfaces that only accept nodes take `NodeType`, etc.
 */
export const ENTITY_TYPES = [
  ...NODE_TYPES,
  ...POLICY_TYPES,
  USER_TYPE,
  EDGE_ID_TYPE,
  ...CONTAINER_TYPES,
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type EntityId<T extends EntityType = EntityType> = Brand<`${T}_${string}`, "EntityId">;

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ENTITY_TYPE_PATTERN = ENTITY_TYPES.join("|");
const ENTITY_ID_REGEX = new RegExp(`^(${ENTITY_TYPE_PATTERN})_([0-9A-HJKMNP-TV-Z]{26})$`);

export function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID_REGEX.test(value);
}

const HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Validate the shape of a handle (Doco or Workspace). Does not check uniqueness. */
export function isHandle(value: unknown): value is DocoHandle | WorkspaceHandle {
  return typeof value === "string" && HANDLE_REGEX.test(value);
}

/**
 * Coerce a string to a DocoHandle after validating shape. Returns null
 * on invalid shape — use this at the boundary (URL params, JSON body)
 * before passing into branded-typed helpers.
 */
export function asDocoHandle(value: string): DocoHandle | null {
  return isHandle(value) ? (value as DocoHandle) : null;
}

/** Coerce a string to an WorkspaceHandle after validating shape. */
export function asWorkspaceHandle(value: string): WorkspaceHandle | null {
  return isHandle(value) ? (value as WorkspaceHandle) : null;
}

export function isEntityId(value: unknown): value is EntityId {
  return typeof value === "string" && ENTITY_ID_REGEX.test(value);
}

export function isEntityIdOf<T extends EntityType>(value: unknown, type: T): value is EntityId<T> {
  if (!isEntityId(value)) return false;
  return value.startsWith(`${type}_`);
}

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

const NODE_TYPE_URL_ALIASES: Readonly<Record<string, NodeType>> = {
  intents: "intent",
  ideas: "idea",
  rules: "rule",
  decisions: "decision",
  actions: "action",
  logs: "log",
  evals: "eval",
  references: "reference",
  states: "state",
  principals: "principal",
};

/**
 * Canonicalize a node type URL segment. Entity URLs are singular
 * (`/<doco>/intent/<id>`), but humans and agents naturally paste plural
 * API/list segments (`/<doco>/intents/<id>`). Accept both at the boundary.
 */
export function normalizeNodeType(value: unknown): NodeType | null {
  if (isNodeType(value)) return value;
  if (typeof value !== "string") return null;
  return NODE_TYPE_URL_ALIASES[value] ?? null;
}

export function isPolicyType(value: unknown): value is PolicyType {
  return typeof value === "string" && (POLICY_TYPES as readonly string[]).includes(value);
}

/** Parse an EntityId into its (type, ulid) parts. Returns null if the string is malformed. */
export function parseEntityId(value: string): { type: EntityType; ulid: Ulid } | null {
  const match = ENTITY_ID_REGEX.exec(value);
  if (!match) return null;
  return { type: match[1] as EntityType, ulid: match[2] as Ulid };
}

/** Construct an EntityId from a (type, ulid) pair without re-validating. */
export function makeEntityId<T extends EntityType>(type: T, ulid: Ulid): EntityId<T> {
  return `${type}_${ulid}` as EntityId<T>;
}
