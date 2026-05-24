/**
 * Branded ID + discriminator types — nominal-style typing so we can't
 * accidentally pass a raw string where an EntityId is expected.
 *
 * Post-rename (migration 005): entities are split across five categories.
 *   - Neurons (10):       graph-knowledge entities
 *   - Policies (2):       Doco-level authoring metadata
 *   - Collaborator (1):   OAuth identity layer
 *   - Doco (1):           workspace container
 *   - Organization (1):   org container
 *
 * `EntityType` is the union of all 14 discriminator strings; `NeuronType`
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

/** URL handle for an Organization — the segment after `/orgs/`. */
export type OrgHandle = Brand<string, "OrgHandle">;

/** The 10 neuron types — graph-knowledge entities. */
export const NEURON_TYPES = [
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "log",
  "eval",
  "reference",
  "state",
  "principal",
] as const;

export type NeuronType = (typeof NEURON_TYPES)[number];

/** The 2 policy types — Doco-level authoring metadata, not on the graph. */
export const POLICY_TYPES = ["guidance_policy", "neuron_authoring_policy"] as const;

export type PolicyType = (typeof POLICY_TYPES)[number];

/** The collaborator type — OAuth identity. One entity, two `kind` values. */
export const COLLABORATOR_TYPE = "collaborator" as const;
export type CollaboratorType = typeof COLLABORATOR_TYPE;

/** The container types — docos and organizations. */
export const CONTAINER_TYPES = ["doco", "organization"] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

/**
 * The union of every entity-type discriminator. Surfaces that genuinely
 * accept any entity (audit log, generic ID parser, search index) take
 * `EntityType`; surfaces that only accept neurons take `NeuronType`, etc.
 */
export const ENTITY_TYPES = [
  ...NEURON_TYPES,
  ...POLICY_TYPES,
  COLLABORATOR_TYPE,
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

/** Validate the shape of a handle (Doco or Org). Does not check uniqueness. */
export function isHandle(value: unknown): value is DocoHandle | OrgHandle {
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

/** Coerce a string to an OrgHandle after validating shape. */
export function asOrgHandle(value: string): OrgHandle | null {
  return isHandle(value) ? (value as OrgHandle) : null;
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

export function isNeuronType(value: unknown): value is NeuronType {
  return typeof value === "string" && (NEURON_TYPES as readonly string[]).includes(value);
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
