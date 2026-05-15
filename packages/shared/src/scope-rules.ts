/**
 * Scope rules engine.
 *
 * A Scope's `rules` array declares predicates that every node tagged with
 * that scope must satisfy. Two flavors:
 *
 *   • Deterministic — `requires_edge`, `requires_field`, `forbids_edge`,
 *     `forbids_field`, `mandatory_scope`. Pure structural checks against
 *     the entity's frontmatter + an `allEdges` snapshot.
 *
 *   • Probabilistic — `probabilistic` with a free-text spec. The engine
 *     returns a `pending` violation; the caller passes it to the LLM
 *     adapter which returns ok/reason. Probabilistic rules don't block by
 *     default; the caller decides whether to surface them as warnings or
 *     errors.
 *
 * This module stays pure (no IO, no LLM client). The caller wires those in.
 *
 * (Distinct from Doco's Rule *node type* — these are the predicates a
 * Scope itself enforces on its members.)
 */

import type { Entity, AuthoringRule, Scope } from "./entities.js";

export interface EngineEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
}

export interface RuleViolation {
  /** Index of the rule in the scope's `authoring_rules` (so callers can cite it). */
  rule_index: number;
  /** Kind of the violated authoring rule (for messaging). */
  kind: AuthoringRule["kind"];
  /** Human-readable explanation. */
  reason: string;
  /** Whether this is a hard error (deterministic) or a soft signal (probabilistic). */
  severity: "error" | "warning" | "pending";
}

export interface EvaluateOptions {
  entity: Entity;
  scope: Scope;
  /** All edges already present in the index. Used by `requires_edge` / `forbids_edge`. */
  allEdges: EngineEdge[];
  /** Scope ids the entity already lists (some callers compute this from the entity). */
  entityScopes?: string[];
}

/**
 * Evaluate every deterministic rule on a scope. Probabilistic rules are
 * returned as `severity: "pending"` for the caller to run through the
 * LLM adapter.
 */
export function evaluateScopeRules(opts: EvaluateOptions): RuleViolation[] {
  const violations: RuleViolation[] = [];
  // Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA the field is now
  // `authoring_rules` (was: `rules`). The engine only ever reads the
  // authoring kind — guidance_rules are agent-facing prose with no
  // automated check, evaluated nowhere.
  const rules = opts.scope.authoring_rules ?? [];
  if (rules.length === 0) return violations;
  // Per decision_01KRPNZY7W6CCMYNKGND67BP0B rules with lifecycle
  // `abandoned` / `superseded` are skipped (soft-deprecation); the
  // index in the array stays stable so `rule_index` on violations still
  // resolves back to the right slot for callers that look up the spec.
  const isActiveLifecycle = (r: unknown): boolean => {
    const lc = (r as { lifecycle?: string }).lifecycle;
    return lc === undefined || lc === "active" || lc === "proposed";
  };

  const entity = opts.entity as unknown as Record<string, unknown>;
  const entityId = (entity.id as string) ?? "";
  const entityScopes =
    opts.entityScopes ?? (Array.isArray(entity.scopes) ? (entity.scopes as string[]) : []);

  // Pre-index this entity's outgoing edges for cheap lookup.
  const outgoing = opts.allEdges.filter((e) => e.from_id === entityId);

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (!isActiveLifecycle(rule)) continue;
    switch (rule.kind) {
      case "requires_edge": {
        const matched = outgoing.some(
          (e) =>
            e.edge_type === rule.edge_type &&
            (rule.target_node_type === undefined ||
              e.to_id.startsWith(`${rule.target_node_type}_`)),
        );
        if (!matched) {
          violations.push({
            rule_index: i,
            kind: rule.kind,
            severity: "error",
            reason:
              rule.reason ??
              `Nodes in scope "${opts.scope.name}" must have an outgoing \`${rule.edge_type}\` edge${rule.target_node_type ? ` to a ${rule.target_node_type}` : ""}.`,
          });
        }
        break;
      }
      case "forbids_edge": {
        const matched = outgoing.some(
          (e) =>
            e.edge_type === rule.edge_type &&
            (rule.target_node_type === undefined ||
              e.to_id.startsWith(`${rule.target_node_type}_`)),
        );
        if (matched) {
          violations.push({
            rule_index: i,
            kind: rule.kind,
            severity: "error",
            reason:
              rule.reason ??
              `Nodes in scope "${opts.scope.name}" must NOT have a \`${rule.edge_type}\` edge${rule.target_node_type ? ` to a ${rule.target_node_type}` : ""}.`,
          });
        }
        break;
      }
      case "requires_field": {
        for (const field of readFieldList(rule)) {
          const v = entity[field];
          const present = v !== undefined && v !== null && v !== "";
          if (!present) {
            violations.push({
              rule_index: i,
              kind: rule.kind,
              severity: "error",
              reason:
                rule.reason ??
                `Nodes in scope "${opts.scope.name}" must declare \`${field}\` in their frontmatter.`,
            });
          }
        }
        break;
      }
      case "forbids_field": {
        for (const field of readFieldList(rule)) {
          const v = entity[field];
          const present = v !== undefined && v !== null && v !== "";
          if (present) {
            violations.push({
              rule_index: i,
              kind: rule.kind,
              severity: "error",
              reason:
                rule.reason ??
                `Nodes in scope "${opts.scope.name}" must NOT declare \`${field}\`.`,
            });
          }
        }
        break;
      }
      case "mandatory_scope": {
        // The Constitution publishes mandatory-scope rules — applies to
        // EVERY node in the Doco, not just members of this scope. The
        // capture path always runs these rules against the Constitution
        // scope, regardless of whether the node is tagged with the
        // Constitution itself.
        for (const scopeId of readScopeIdList(rule)) {
          if (!entityScopes.includes(scopeId)) {
            violations.push({
              rule_index: i,
              kind: rule.kind,
              severity: "error",
              reason:
                rule.reason ??
                `Every node in this Doco must declare scope \`${scopeId}\` (mandatory per the Constitution).`,
            });
          }
        }
        break;
      }
      case "probabilistic": {
        // Caller responsibility — return `pending` so they can run the LLM.
        violations.push({
          rule_index: i,
          kind: rule.kind,
          severity: "pending",
          reason: `Probabilistic check pending — spec: "${rule.spec}".`,
        });
        break;
      }
    }
  }
  return violations;
}

/**
 * Convenience: filter to deterministic-only failures (the ones that should
 * block a capture).
 */
export function hardFailures(violations: RuleViolation[]): RuleViolation[] {
  return violations.filter((v) => v.severity === "error");
}

export function pendingProbabilistic(violations: RuleViolation[]): RuleViolation[] {
  return violations.filter((v) => v.severity === "pending");
}

// Accept both the plural form (`fields: string[]`) and the legacy singular
// form (`field: string`) so YAML written before the plural rollout still
// evaluates. Empty / non-string entries are dropped silently.
function readFieldList(rule: AuthoringRule): string[] {
  const rec = rule as unknown as Record<string, unknown>;
  if (Array.isArray(rec.fields)) {
    return rec.fields.filter((f): f is string => typeof f === "string" && f.length > 0);
  }
  if (typeof rec.field === "string" && rec.field.length > 0) return [rec.field];
  return [];
}

function readScopeIdList(rule: AuthoringRule): string[] {
  const rec = rule as unknown as Record<string, unknown>;
  if (Array.isArray(rec.scope_ids)) {
    return rec.scope_ids.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (typeof rec.scope_id === "string" && rec.scope_id.length > 0) return [rec.scope_id];
  return [];
}
