/**
 * Human + agent rendering of policies. One home for the
 * "[kind] / Agent instruction / structured deterministic" presentation so the
 * web UI, the agent-facing `.txt` surfaces, Slack, and violation messages stay
 * in sync.
 */

import type { DeterministicPredicate, PolicyKind, PolicyPredicate } from "./entities.js";

export function isDeterministicPredicate(p: PolicyPredicate): p is DeterministicPredicate {
  return "sub_kind" in p;
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

const SUB_KIND_HEADLINE: Record<DeterministicPredicate["sub_kind"], string> = {
  requires_edge: "Requires edge",
  requires_edge_role: "Requires edge role",
  forbids_edge: "Forbids edge",
  requires_field: "Requires field",
  forbids_field: "Forbids field",
  forbids_field_pattern: "Forbids field pattern",
  "flow-wiring": "Flow wiring",
  unique_field: "Unique field",
  requires_node_type: "Allowed node types",
  requires_entity_type: "Allowed entity types",
  "graph-completeness": "Graph completeness",
  requires_field_resolves_to_principal: "Field resolves to Principal",
};

/** The headline name of a deterministic check. */
export function deterministicHeadline(p: DeterministicPredicate): string {
  return SUB_KIND_HEADLINE[p.sub_kind];
}

/** Break a deterministic predicate into labeled parts for human-readable rendering. */
export function deterministicParts(p: DeterministicPredicate): PredicatePart[] {
  const parts: PredicatePart[] = [];
  switch (p.sub_kind) {
    case "requires_edge":
      parts.push({ label: "edge type", value: p.edge_type });
      if (p.target_node_type) parts.push({ label: "target", value: p.target_node_type });
      if (p.min_count && p.min_count > 1)
        parts.push({ label: "min count", value: String(p.min_count) });
      break;
    case "forbids_edge":
      parts.push({ label: "edge type", value: p.edge_type });
      if (p.target_node_type) parts.push({ label: "target", value: p.target_node_type });
      break;
    case "requires_edge_role":
      parts.push({ label: "edge type", value: p.edge_type });
      parts.push({ label: "role", value: p.edge_role });
      if (p.direction) parts.push({ label: "direction", value: p.direction });
      if (p.target_node_type) parts.push({ label: "target", value: p.target_node_type });
      if (p.exempt_when_role) parts.push({ label: "exempt role", value: p.exempt_when_role });
      break;
    case "requires_field":
    case "forbids_field":
      parts.push({ label: "fields", value: p.fields.join(", ") });
      break;
    case "forbids_field_pattern":
      parts.push({ label: "fields", value: p.fields.join(", ") });
      parts.push({ label: "pattern", value: p.pattern });
      break;
    case "flow-wiring":
      parts.push({ label: "edge type", value: p.edge_type });
      if (p.initial_when)
        parts.push({
          label: "initial when",
          value: `${p.initial_when.field}=${p.initial_when.equals}`,
        });
      if (p.terminal_when)
        parts.push({
          label: "terminal when",
          value: `${p.terminal_when.field}=${p.terminal_when.equals}`,
        });
      break;
    case "unique_field":
      parts.push({ label: "field", value: p.field });
      if (p.case_fold) parts.push({ label: "case-insensitive", value: "yes" });
      break;
    case "requires_node_type":
      parts.push({ label: "node types", value: p.node_types.join(", ") });
      break;
    case "requires_entity_type":
      parts.push({ label: "entity types", value: p.entity_types.join(", ") });
      break;
    case "requires_field_resolves_to_principal":
      parts.push({ label: "field", value: p.field });
      break;
    case "graph-completeness":
      parts.push({ label: "list field", value: p.list_field });
      parts.push({ label: "edge type", value: p.edge_type });
      parts.push({ label: "incoming node", value: p.incoming_node_type });
      parts.push({ label: "must match", value: p.incoming_field_must_match });
      break;
  }
  if ("when_node_type" in p && p.when_node_type && p.when_node_type.length > 0) {
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
