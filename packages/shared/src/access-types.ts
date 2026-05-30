// Per-type write access control (decision_per_type_write_grants).
//
// The access model is "grant up from reader": every collaborator (human
// or agent) reads the whole Doco, and WRITE is granted per type. A grant
// is a set of writable-type tokens stored on the membership row
// (doco_users / org_users) or the OAuth token's granted scope.
//
//   - role "owner"  → administers the Doco; writes every type implicitly.
//   - role "reader" → reads everything; writes nothing unless granted.
//   - the wildcard token "*" in a write-type set → writes every type
//     (this is how a pre-per-type "writer" is represented after backfill).
//
// The gateable universe is the 10 node types plus the edge/relation
// types. Both lists are defined here so the access layer has ONE source
// of truth; the web graph-authoring contract (RELATION_KINDS) is checked
// against EDGE_TYPES by a consistency test so the two can't drift.

import { NODE_TYPES, type NodeType } from "./branded.js";

/** Wildcard write-type token: grants write on every type. */
export const WRITE_ALL = "*" as const;

/**
 * Edge / relation types that can be independently write-gated. Mirrors
 * the keys of the web layer's RELATION_KINDS registry; a consistency test
 * asserts the two stay identical.
 */
export const EDGE_TYPES = [
  "sequence_flow",
  "preceded_by",
  "serves",
  "enacts",
  "gated_by",
  "consults",
  "tests",
  "born_from",
  "superseded_by",
  "implemented_by",
  "reports_to",
  "performed_by",
  "owned_by",
  "has_parent",
  "has_stakeholder",
  // Associative ("see also") relation. The SKOS `related` analogue: a
  // generic, untyped link between two peer nodes with no hierarchy or
  // direction implied. Glossaries use it to connect related, confusable,
  // parent/child, or homograph terms into a navigable vocabulary network.
  "relates_to",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * Endpoint node-type constraints for semantically-typed edges, enforced at
 * the edge-capture boundary so the graph can't accumulate nonsense edges
 * (e.g. a `serves` edge that points at a Decision instead of an Intent).
 * `from` / `to` list the node types each endpoint may be; an absent key
 * means "any node type". Edge types omitted here (sequence_flow,
 * preceded_by, born_from, superseded_by, implemented_by, relates_to) accept
 * any endpoints by design — they're generic associative/provenance links.
 */
export const EDGE_ENDPOINT_TYPES: Record<
  string,
  { from?: readonly NodeType[]; to?: readonly NodeType[] }
> = {
  serves: { to: ["intent"] },
  enacts: { to: ["decision"] },
  gated_by: { to: ["rule"] },
  consults: { to: ["rule"] },
  tests: { from: ["eval", "reference"] },
  reports_to: { from: ["principal"], to: ["principal"] },
  performed_by: { to: ["principal"] },
  owned_by: { to: ["principal"] },
  has_parent: { from: ["intent"], to: ["intent"] },
  has_stakeholder: { to: ["principal"] },
};

/** Every write-gateable type: the 10 node types plus the edge types. */
export const WRITABLE_TYPES = [...NODE_TYPES, ...EDGE_TYPES] as const;

export type WritableType = NodeType | EdgeType;

const WRITABLE_TYPE_SET: ReadonlySet<string> = new Set(WRITABLE_TYPES);

/** True when `t` is a known write-gateable type token (not the wildcard). */
export function isWritableType(t: string): t is WritableType {
  return WRITABLE_TYPE_SET.has(t);
}

/**
 * Normalize a raw write-type set read from storage (a text[] or JSON
 * array). Keeps the wildcard and known types, drops unknown tokens, and
 * de-duplicates. A set containing the wildcard collapses to just ["*"].
 */
export function normalizeWriteTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    if (v === WRITE_ALL) return [WRITE_ALL];
    if (isWritableType(v)) out.add(v);
  }
  return [...out];
}

/**
 * The effective-write predicate. `role` is the membership role on the
 * Doco; `writeTypes` is the per-type grant set from the membership row
 * (already normalized or raw). Owners write everything; otherwise the
 * type must be covered by the wildcard or named explicitly.
 */
export function canWriteType(
  role: "owner" | "writer" | "reader" | null | undefined,
  writeTypes: readonly string[] | null | undefined,
  type: WritableType,
): boolean {
  if (role === "owner") return true;
  if (!writeTypes || writeTypes.length === 0) return false;
  return writeTypes.includes(WRITE_ALL) || writeTypes.includes(type);
}

/** True when this grant can write at least one type (any write at all). */
export function canWriteAnything(
  role: "owner" | "writer" | "reader" | null | undefined,
  writeTypes: readonly string[] | null | undefined,
): boolean {
  if (role === "owner") return true;
  return !!writeTypes && writeTypes.length > 0;
}
