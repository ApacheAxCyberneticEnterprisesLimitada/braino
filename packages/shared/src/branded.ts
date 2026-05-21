/**
 * Branded primitive types — give us nominal-style typing in TypeScript so we can't
 * accidentally pass a raw string where an EntityId is expected.
 */

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type Ulid = Brand<string, "Ulid">;

export const NODE_TYPES = [
  "doco",
  "principal",
  "organization",
  "intent",
  "idea",
  "rule",
  "guidance_article",
  "node_authoring_article",
  "decision",
  "action",
  "log",
  "eval",
  "reference",
  "state",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export type EntityId<T extends NodeType = NodeType> = Brand<`${T}_${string}`, "EntityId">;

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NODE_TYPE_PATTERN = NODE_TYPES.join("|");
const ENTITY_ID_REGEX = new RegExp(`^(${NODE_TYPE_PATTERN})_([0-9A-HJKMNP-TV-Z]{26})$`);

export function isUlid(value: unknown): value is Ulid {
  return typeof value === "string" && ULID_REGEX.test(value);
}

export function isEntityId(value: unknown): value is EntityId {
  return typeof value === "string" && ENTITY_ID_REGEX.test(value);
}

export function isEntityIdOf<T extends NodeType>(value: unknown, type: T): value is EntityId<T> {
  if (!isEntityId(value)) return false;
  return value.startsWith(`${type}_`);
}

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

/** Parse an EntityId into its (type, ulid) parts. Returns null if the string is malformed. */
export function parseEntityId(value: string): { type: NodeType; ulid: Ulid } | null {
  const match = ENTITY_ID_REGEX.exec(value);
  if (!match) return null;
  return { type: match[1] as NodeType, ulid: match[2] as Ulid };
}

/** Construct an EntityId from a (type, ulid) pair without re-validating. Use after `isUlid`/`isEntityId` checks. */
export function makeEntityId<T extends NodeType>(type: T, ulid: Ulid): EntityId<T> {
  return `${type}_${ulid}` as EntityId<T>;
}
