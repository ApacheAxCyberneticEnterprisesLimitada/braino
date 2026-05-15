/**
 * Scope rules engine — evaluates a node against a set of authoring
 * predicates that apply to one of its scopes.
 *
 * Per decision_01KRPRDR1AD7S1RP6E69BQDB2G authoring rules are now
 * first-class Rule entities (kind: "authoring" with a typed `predicate`
 * in their frontmatter). The engine still takes the predicates as input;
 * the caller is responsible for loading the Rule entities and pulling
 * each one's `predicate` and `lifecycle`. The engine doesn't know the
 * predicates came from Rule entities — it just evaluates them.
 *
 * Predicate flavors:
 *
 *   • Deterministic — `requires_edge`, `requires_field`, `forbids_edge`,
 *     `forbids_field`, `mandatory_scope`. Pure structural checks against
 *     the entity's frontmatter + an `allEdges` snapshot.
 *
 *   • Probabilistic — `probabilistic` with a free-text spec. The engine
 *     returns a `pending` violation; the caller passes it to the LLM
 *     adapter which returns ok/reason. The caller decides whether to
 *     surface them as warnings or errors.
 *
 * Pure module — no IO, no LLM client. Inputs in, violations out.
 */

import type { Entity, AuthoringPredicate } from "./entities.js";

export interface EngineEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
}

/**
 * An authoring predicate loaded from a Rule entity, with the per-rule
 * fields the engine needs: the predicate itself, the lifecycle (so it
 * can be skipped if deprecated), and an optional human-readable reason
 * (typically the Rule's summary).
 */
export interface LoadedAuthoringRule {
  /** Stable id back to the Rule entity (so callers can resolve violations to a rule). */
  rule_id: string;
  predicate: AuthoringPredicate;
  /** Defaults to "active" when unset. */
  lifecycle?: string;
  /** Human-readable reason — typically the Rule's summary. */
  reason?: string;
}

export interface RuleViolation {
  /** Rule entity id that produced the violation. */
  rule_id: string;
  /** Kind of the violated predicate (for messaging). */
  kind: AuthoringPredicate["kind"];
  /** Human-readable explanation. */
  reason: string;
  /** Whether this is a hard error (deterministic) or a soft signal (probabilistic). */
  severity: "error" | "warning" | "pending";
  /**
   * For probabilistic violations, the spec to feed the LLM judge.
   * Callers don't need to look up the rule by id — the spec is here.
   */
  spec?: string;
}

export interface EvaluateOptions {
  entity: Entity;
  /**
   * The authoring rules to evaluate. Loaded by the caller from the
   * `rules` table (kind=authoring, in_scope_of the relevant scope,
   * lifecycle active/proposed).
   */
  authoring_rules: LoadedAuthoringRule[];
  /** Optional scope name — used only for error message text. */
  scopeName?: string;
  /** All edges already present in the index. Used by `requires_edge` / `forbids_edge`. */
  allEdges: EngineEdge[];
  /** Scope ids the entity already lists (some callers compute this from the entity). */
  entityScopes?: string[];
}

/**
 * Evaluate every deterministic predicate. Probabilistic predicates are
 * returned as `severity: "pending"` for the caller to run through the
 * LLM judge.
 */
export function evaluateScopeRules(opts: EvaluateOptions): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const rules = opts.authoring_rules ?? [];
  if (rules.length === 0) return violations;

  // Per decision_01KRPNZY7W6CCMYNKGND67BP0B rules with lifecycle
  // `abandoned` / `superseded` are skipped (soft-deprecation). Callers
  // typically pre-filter, but defend in depth here too.
  const isActiveLifecycle = (lc: string | undefined): boolean =>
    lc === undefined || lc === "active" || lc === "proposed";

  const entity = opts.entity as unknown as Record<string, unknown>;
  const entityId = (entity.id as string) ?? "";
  const entityScopes =
    opts.entityScopes ?? (Array.isArray(entity.scopes) ? (entity.scopes as string[]) : []);
  const scopeName = opts.scopeName ?? "(scope)";

  // Pre-index this entity's outgoing edges for cheap lookup.
  const outgoing = opts.allEdges.filter((e) => e.from_id === entityId);

  for (const loaded of rules) {
    if (!isActiveLifecycle(loaded.lifecycle)) continue;
    const rule = loaded.predicate;
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
            rule_id: loaded.rule_id,
            kind: rule.kind,
            severity: "error",
            reason:
              loaded.reason ??
              `Nodes in scope "${scopeName}" must have an outgoing \`${rule.edge_type}\` edge${rule.target_node_type ? ` to a ${rule.target_node_type}` : ""}.`,
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
            rule_id: loaded.rule_id,
            kind: rule.kind,
            severity: "error",
            reason:
              loaded.reason ??
              `Nodes in scope "${scopeName}" must NOT have a \`${rule.edge_type}\` edge${rule.target_node_type ? ` to a ${rule.target_node_type}` : ""}.`,
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
              rule_id: loaded.rule_id,
              kind: rule.kind,
              severity: "error",
              reason:
                loaded.reason ??
                `Nodes in scope "${scopeName}" must declare \`${field}\` in their frontmatter.`,
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
              rule_id: loaded.rule_id,
              kind: rule.kind,
              severity: "error",
              reason:
                loaded.reason ??
                `Nodes in scope "${scopeName}" must NOT declare \`${field}\`.`,
            });
          }
        }
        break;
      }
      case "mandatory_scope": {
        // The Global scope's authoring rules with kind=mandatory_scope
        // apply Doco-wide. The capture path always evaluates them
        // regardless of whether the candidate node is tagged with Global.
        for (const scopeId of readScopeIdList(rule)) {
          if (!entityScopes.includes(scopeId)) {
            violations.push({
              rule_id: loaded.rule_id,
              kind: rule.kind,
              severity: "error",
              reason:
                loaded.reason ??
                `Every node in this Doco must declare scope \`${scopeId}\` (mandatory per the Global scope).`,
            });
          }
        }
        break;
      }
      case "probabilistic": {
        violations.push({
          rule_id: loaded.rule_id,
          kind: rule.kind,
          severity: "pending",
          reason: `Probabilistic check pending — spec: "${rule.spec}".`,
          spec: rule.spec,
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
// form (`field: string`) so older predicates still evaluate. Empty /
// non-string entries are dropped silently.
function readFieldList(rule: AuthoringPredicate): string[] {
  const rec = rule as unknown as Record<string, unknown>;
  if (Array.isArray(rec.fields)) {
    return rec.fields.filter((f): f is string => typeof f === "string" && f.length > 0);
  }
  if (typeof rec.field === "string" && rec.field.length > 0) return [rec.field];
  return [];
}

function readScopeIdList(rule: AuthoringPredicate): string[] {
  const rec = rule as unknown as Record<string, unknown>;
  if (Array.isArray(rec.scope_ids)) {
    return rec.scope_ids.filter((s): s is string => typeof s === "string" && s.length > 0);
  }
  if (typeof rec.scope_id === "string" && rec.scope_id.length > 0) return [rec.scope_id];
  return [];
}
