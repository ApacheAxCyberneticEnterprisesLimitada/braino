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
// The gateable universe is the 10 neuron types plus the synapse/relation
// types. Both lists are defined here so the access layer has ONE source
// of truth; the web graph-authoring contract (RELATION_KINDS) is checked
// against SYNAPSE_TYPES by a consistency test so the two can't drift.

import { NEURON_TYPES, type NeuronType } from "./branded.js";

/** Wildcard write-type token: grants write on every type. */
export const WRITE_ALL = "*" as const;

/**
 * Synapse / relation types that can be independently write-gated. Mirrors
 * the keys of the web layer's RELATION_KINDS registry; a consistency test
 * asserts the two stay identical.
 */
export const SYNAPSE_TYPES = [
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
] as const;

export type SynapseType = (typeof SYNAPSE_TYPES)[number];

/** Every write-gateable type: the 10 neuron types plus the synapse types. */
export const WRITABLE_TYPES = [...NEURON_TYPES, ...SYNAPSE_TYPES] as const;

export type WritableType = NeuronType | SynapseType;

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
