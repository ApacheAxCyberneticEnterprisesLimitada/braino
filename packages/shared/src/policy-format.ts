/**
 * Human + agent rendering of policies. One home for the
 * "[kind] / Agent instruction / structured deterministic" presentation so the
 * web UI, the agent-facing `.txt` surfaces, Slack, and violation messages stay
 * in sync.
 *
 * Deterministic rendering (the headline and the "composed of parts" breakdown)
 * is derived from the check registry's field schema — see
 * `deterministic-checks.ts` — so there is no per-sub_kind switch to keep in
 * step here.
 */

import { type FieldSpec, checkFields, checkLabel } from "./deterministic-checks.js";
import type {
  AgentInstructionPredicate,
  DeterministicPredicate,
  EdgeAgentInstructionPredicate,
  PolicyKind,
  PolicyPredicate,
} from "./entities.js";

export function isDeterministicPredicate(p: PolicyPredicate): p is DeterministicPredicate {
  return "sub_kind" in p;
}

/**
 * Whether a (probabilistic) predicate is edge-scoped — fires on edge creation
 * with both endpoints handed to the judge, rather than on a single node.
 */
export function isEdgePredicate(p: PolicyPredicate): p is EdgeAgentInstructionPredicate {
  return "agent_instruction" in p && "edge_type" in p;
}

/** The single natural-language instruction for suggestion / probabilistic policies. */
export function agentInstructionOf(p: PolicyPredicate): string | null {
  return "agent_instruction" in p ? p.agent_instruction : null;
}

export const POLICY_KIND_LABEL: Record<PolicyKind, string> = {
  suggestion: "Suggestion",
  deterministic: "Deterministic",
  probabilistic: "Probabilistic",
};

/** A labeled field of a deterministic predicate, for "composed of parts" rendering. */
export interface PredicatePart {
  label: string;
  value: string;
}

/** The headline name of a deterministic check. */
export function deterministicHeadline(p: DeterministicPredicate): string {
  return checkLabel(p.sub_kind);
}

/** Render one configured field as a labeled part, or null when it carries no value. */
function formatPart(field: FieldSpec, value: unknown): string | null {
  switch (field.control) {
    case "checkbox":
      return value === true ? "yes" : null;
    case "condition": {
      if (!value || typeof value !== "object") return null;
      const c = value as { field?: unknown; equals?: unknown };
      if (typeof c.field !== "string" || typeof c.equals !== "string") return null;
      return `${c.field}=${c.equals}`;
    }
    case "number":
      return typeof value === "number" ? String(value) : null;
    case "node-type-csv":
    case "entity-type-csv":
    case "edge-type-csv":
    case "field-csv":
      return Array.isArray(value) && value.length > 0
        ? value.filter((v) => typeof v === "string").join(", ")
        : null;
    default:
      // edge-type / node-type / direction / text — a non-empty string.
      return typeof value === "string" && value.length > 0 ? value : null;
  }
}

/** Break a deterministic predicate into labeled parts for human-readable rendering. */
export function deterministicParts(p: DeterministicPredicate): PredicatePart[] {
  const rec = p as Record<string, unknown>;
  const parts: PredicatePart[] = [];
  for (const field of checkFields(p.sub_kind)) {
    const value = formatPart(field, rec[field.name]);
    if (value !== null) parts.push({ label: field.partLabel, value });
  }
  return parts;
}

/**
 * Scope of a suggestion / probabilistic predicate as labeled parts — the same
 * "labeled rows" shape `deterministicParts` produces, so prose policies render
 * their scope identically. A node check shows the node type(s) it judges
 * (`when_node_type`); an edge-scoped check shows the edge it fires on and
 * whichever endpoint types it pins. An unscoped node check (fires on every
 * node) yields no parts.
 */
export function agentInstructionParts(
  p: AgentInstructionPredicate | EdgeAgentInstructionPredicate,
): PredicatePart[] {
  const parts: PredicatePart[] = [];
  if (isEdgePredicate(p)) {
    parts.push({ label: "edge type", value: p.edge_type });
    if (p.from_node_type) parts.push({ label: "from node type", value: p.from_node_type });
    if (p.to_node_type) parts.push({ label: "to node type", value: p.to_node_type });
  } else if (p.when_node_type && p.when_node_type.length > 0) {
    parts.push({ label: "when node type", value: p.when_node_type.join(", ") });
  }
  return parts;
}

/** One-line human summary of any policy predicate. */
export function summarizePredicate(predicate: PolicyPredicate): string {
  if (isDeterministicPredicate(predicate)) {
    const parts = deterministicParts(predicate);
    const detail = parts.map((part) => `${part.label}: ${part.value}`).join("; ");
    return detail
      ? `${deterministicHeadline(predicate)} — ${detail}`
      : deterministicHeadline(predicate);
  }
  return predicate.agent_instruction;
}
