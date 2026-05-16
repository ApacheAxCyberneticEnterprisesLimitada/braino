/**
 * Scope rules engine — evaluates a node against a set of authoring
 * predicates that apply to one of its scopes.
 *
 * Per decision_01KRPRDR1AD7S1RP6E69BQDB2G authoring rules are now
 * first-class Rule entities; per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG)
 * the engine identifies authoring rules via the `Scope.gated_by` citation
 * rather than a `Rule.kind === "authoring"` flag (which no longer exists).
 * The caller loads the cited Rule entities for the candidate's scopes
 * (Global plus each listed scope, with parent-scope inheritance and
 * per-scope `excluded_rules` opt-out applied), then pulls each Rule's
 * `predicate`, `lifecycle`, and (v7) `fires_when_node_lifecycle` and
 * passes them in. The engine doesn't know the predicates came from Rule
 * entities — it just evaluates them.
 *
 * Predicate flavors:
 *
 *   • Deterministic — `requires_edge`, `requires_field`, `forbids_edge`,
 *     `forbids_field`, `mandatory_scope`, `requires_node_type`. Pure
 *     structural checks against the entity's frontmatter + an `allEdges`
 *     snapshot.
 *
 *   • Within-scope (v7) — `unique-within-scope`, `count-within-scope`,
 *     `graph-constraint`. Need the population of nodes in the relevant
 *     scope; the caller supplies `nodesByScope`. `scope_ref` accepts
 *     either a literal scope_id or the string `"$capture_scope"`, which
 *     resolves to the rule's owning scope (the scope that cited the
 *     rule via `gated_by`). The caller stamps that owning scope onto
 *     `LoadedAuthoringRule.scope_id`.
 *
 *   • Descriptive (v7) — `descriptive` carries a prose spec the engine
 *     records but never enforces. Used for guard predicates that the
 *     project owner wants to surface to readers but doesn't want the
 *     engine to evaluate.
 *
 *   • Probabilistic — `probabilistic` with a free-text spec. The engine
 *     returns a `pending` violation; the caller passes it to the LLM
 *     adapter which returns ok/reason. The caller decides whether to
 *     surface them as warnings or errors.
 *
 * Per decision_01KRRD5SRX69P2MWN0G1B8216H, the four most common
 * deterministic predicates (`requires_edge`, `forbids_edge`,
 * `requires_field`, `forbids_field`) accept an optional
 * `when_node_type: NodeType[]` filter. When set, the rule fires only for
 * captures whose `node_type` is in the list; otherwise it's a no-op.
 * `mandatory_scope` and `requires_node_type` already constrain the
 * candidate's shape directly, so they don't carry the filter.
 *
 * Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG), every Rule can carry an
 * optional `fires_when_node_lifecycle: Lifecycle[]` filter. The engine
 * skips a rule whose filter is set and doesn't include the candidate's
 * own lifecycle — letting "completeness" rules ignore mid-construction
 * (drafted) captures and check only at activation.
 *
 * `requires_field` treats an empty array (`[]`) as "not populated" — the
 * same way it treats `undefined` / `null` / `""`. This makes
 * `requires_field: ["alternatives"]` reject a Decision whose
 * `alternatives` is the literal empty list.
 *
 * Pure module — no IO, no LLM client. Inputs in, violations out.
 */

import type {
  AuthoringPredicate,
  Entity,
  Lifecycle,
  Scope,
  WithinScopeWhere,
} from "./entities.js";

export interface EngineEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
}

/**
 * An authoring predicate loaded from a Rule entity, with the per-rule
 * fields the engine needs: the predicate itself, the lifecycle (so it
 * can be skipped if abandoned), and an optional human-readable reason
 * (typically the Rule's summary).
 */
export interface LoadedAuthoringRule {
  /** Stable id back to the Rule entity (so callers can resolve violations to a rule). */
  rule_id: string;
  /**
   * Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): the scope from which
   * this rule was loaded — i.e., the scope that cited it via
   * `gated_by`. Used to resolve the `"$capture_scope"` literal in
   * within-scope predicates. Optional because Global-scope rules may
   * not need resolution; the caller passes the global scope id when
   * relevant.
   */
  scope_id?: string;
  predicate: AuthoringPredicate;
  /** Defaults to "active" when unset. */
  lifecycle?: string;
  /**
   * Per v7: when set, the rule only fires against candidates whose
   * `lifecycle` is in this list. Used by completeness predicates that
   * want to skip drafted nodes mid-refactor.
   */
  fires_when_node_lifecycle?: Lifecycle[];
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
   * scopes' `gated_by` lists (with parent-scope inheritance and
   * per-scope `excluded_rules` opt-out applied), plus the Global
   * scope's `gated_by`, for Rule lifecycle active/proposed.
   */
  authoring_rules: LoadedAuthoringRule[];
  /** Optional scope name — used only for error message text. */
  scopeName?: string;
  /** All edges already present in the index. Used by `requires_edge` / `forbids_edge` and v7 within-scope predicates. */
  allEdges: EngineEdge[];
  /** Scope ids the entity already lists (some callers compute this from the entity). */
  entityScopes?: string[];
  /**
   * Per v7: nodes by scope id. Used by `unique-within-scope`,
   * `count-within-scope`, and `graph-constraint` predicates to assess
   * the population of the scope. The caller is responsible for
   * inclusion: if the candidate claims a scope, the candidate must
   * appear in that scope's list so completeness checks see it.
   */
  nodesByScope?: Map<string, Entity[]>;
  /** Per v7: id → entity map for cross-references and graph traversal. */
  entityIndex?: Map<string, Entity>;
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
  // `abandoned` / `superseded` are skipped. Callers
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
  const candidateNodeType = typeof entity.node_type === "string" ? entity.node_type : "";

  // Optional per-rule node-type filter (decision_01KRRD5SRX69P2MWN0G1B8216H).
  // When set on a predicate that supports it, fire only for matching types.
  // Empty/undefined → fire for every type (legacy behavior).
  const shouldFire = (when: unknown): boolean => {
    if (!Array.isArray(when) || when.length === 0) return true;
    return when.some((t) => typeof t === "string" && t === candidateNodeType);
  };

  const candidateLifecycle =
    typeof entity.lifecycle === "string" ? (entity.lifecycle as Lifecycle) : undefined;

  for (const loaded of rules) {
    if (!isActiveLifecycle(loaded.lifecycle)) continue;
    // Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): when the rule sets
    // `fires_when_node_lifecycle`, skip if the candidate's lifecycle
    // isn't in that list. Lets completeness rules ignore drafted nodes.
    if (
      Array.isArray(loaded.fires_when_node_lifecycle) &&
      loaded.fires_when_node_lifecycle.length > 0 &&
      (candidateLifecycle === undefined ||
        !loaded.fires_when_node_lifecycle.includes(candidateLifecycle))
    ) {
      continue;
    }
    const rule = loaded.predicate;
    switch (rule.kind) {
      case "requires_edge": {
        if (!shouldFire((rule as { when_node_type?: unknown }).when_node_type)) break;
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
        if (!shouldFire((rule as { when_node_type?: unknown }).when_node_type)) break;
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
        if (!shouldFire((rule as { when_node_type?: unknown }).when_node_type)) break;
        for (const field of readFieldList(rule)) {
          const v = entity[field];
          const present =
            v !== undefined &&
            v !== null &&
            v !== "" &&
            !(Array.isArray(v) && v.length === 0);
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
        if (!shouldFire((rule as { when_node_type?: unknown }).when_node_type)) break;
        for (const field of readFieldList(rule)) {
          const v = entity[field];
          const present =
            v !== undefined &&
            v !== null &&
            v !== "" &&
            !(Array.isArray(v) && v.length === 0);
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
        // mandatory_scope is most often used by Global authoring rules,
        // but the predicate itself is plain structural logic: all listed
        // scopes must be present on the candidate node.
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
      case "requires_node_type": {
        // The captured node's `node_type` must appear in the rule's
        // allowed list. Used by the Global scope's "only Rule nodes
        // belong here" authoring rule.
        const allowed = Array.isArray(rule.node_types) ? rule.node_types : [];
        const nodeType = typeof entity.node_type === "string" ? entity.node_type : "";
        if (allowed.length > 0 && !allowed.includes(nodeType as never)) {
          violations.push({
            rule_id: loaded.rule_id,
            kind: rule.kind,
            severity: "error",
            reason:
              loaded.reason ??
              `Nodes in scope "${scopeName}" must be of type ${allowed.map((t) => `\`${t}\``).join(" or ")} — got \`${nodeType || "(unknown)"}\`.`,
          });
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
      case "descriptive": {
        // v7: documentation-only. The engine records it but never
        // produces a violation. Listed for completeness so the switch
        // is exhaustive.
        break;
      }
      case "unique-within-scope": {
        const targetScopeId = resolveScopeRef(rule.scope_ref, loaded.scope_id);
        if (!targetScopeId) break;
        const nodeTypeCheck = String(rule.node_type);
        if (candidateNodeType !== nodeTypeCheck) break;
        const fieldVal = entity[rule.field];
        if (fieldVal === undefined || fieldVal === null || fieldVal === "") break;
        const population = nodesInScope(opts.nodesByScope, targetScopeId);
        const conflict = population.some((other) => {
          if ((other as { id?: string }).id === entityId) return false;
          if (other.node_type !== nodeTypeCheck) return false;
          if (!matchesWhere(other, rule.where)) return false;
          const otherVal = (other as unknown as Record<string, unknown>)[rule.field];
          return otherVal === fieldVal;
        });
        if (conflict) {
          violations.push({
            rule_id: loaded.rule_id,
            kind: rule.kind,
            severity: "error",
            reason:
              loaded.reason ??
              `\`${rule.field}\` must be unique among ${rule.node_type} nodes within this scope; "${String(
                fieldVal,
              )}" is already taken.`,
          });
        }
        break;
      }
      case "count-within-scope": {
        const targetScopeId = resolveScopeRef(rule.scope_ref, loaded.scope_id);
        if (!targetScopeId) break;
        const populationRaw = nodesInScope(opts.nodesByScope, targetScopeId);
        // Make sure the candidate is included if it claims the scope —
        // callers may or may not pre-merge it.
        const claimsScope = entityScopes.includes(targetScopeId);
        const populationIds = new Set(populationRaw.map((e) => (e as { id?: string }).id ?? ""));
        const population =
          claimsScope && entityId && !populationIds.has(entityId)
            ? [...populationRaw, opts.entity]
            : populationRaw;
        const matches = population.filter(
          (e) =>
            e.node_type === String(rule.node_type) &&
            matchesWhere(e, rule.where),
        );
        if (!compareCount(matches.length, rule.comparator, rule.n)) {
          violations.push({
            rule_id: loaded.rule_id,
            kind: rule.kind,
            severity: "error",
            reason:
              loaded.reason ??
              `Scope requires ${rule.comparator} ${rule.n} ${rule.node_type} node(s)${describeWhere(rule.where)}; found ${matches.length}.`,
          });
        }
        break;
      }
      case "graph-constraint": {
        const targetScopeId = resolveScopeRef(rule.scope_ref, loaded.scope_id);
        if (!targetScopeId) break;
        const population = nodesInScope(opts.nodesByScope, targetScopeId);
        const populationIds = new Set(population.map((e) => (e as { id?: string }).id ?? ""));
        const followsEdges = opts.allEdges.filter((e) => e.edge_type === "follows");
        switch (rule.op) {
          case "alternates-between": {
            const [t1, t2] = rule.node_types;
            for (const e of followsEdges) {
              if (!populationIds.has(e.from_id) || !populationIds.has(e.to_id)) continue;
              const fromType = typePrefix(e.from_id);
              const toType = typePrefix(e.to_id);
              const ok =
                (fromType === t1 && toType === t2) ||
                (fromType === t2 && toType === t1);
              if (!ok) {
                violations.push({
                  rule_id: loaded.rule_id,
                  kind: rule.kind,
                  severity: "error",
                  reason:
                    loaded.reason ??
                    `\`follows\` edges in this scope must alternate ${t1} ↔ ${t2}; edge ${e.from_id} → ${e.to_id} does not.`,
                });
                break; // one error per rule per check is enough
              }
            }
            break;
          }
          case "degree-bounds": {
            for (const node of population) {
              if (!matchesWhere(node, rule.where)) continue;
              const nodeId = (node as { id?: string }).id ?? "";
              const count = followsEdges.filter((e) =>
                rule.direction === "out" ? e.from_id === nodeId : e.to_id === nodeId,
              ).length;
              if (rule.min !== undefined && count < rule.min) {
                violations.push({
                  rule_id: loaded.rule_id,
                  kind: rule.kind,
                  severity: "error",
                  reason:
                    loaded.reason ??
                    `Node ${nodeId} must have ≥${rule.min} ${rule.direction}going \`follows\` edges; has ${count}.`,
                });
              }
              if (rule.max !== undefined && count > rule.max) {
                violations.push({
                  rule_id: loaded.rule_id,
                  kind: rule.kind,
                  severity: "error",
                  reason:
                    loaded.reason ??
                    `Node ${nodeId} must have ≤${rule.max} ${rule.direction}going \`follows\` edges; has ${count}.`,
                });
              }
            }
            break;
          }
          case "references-resolve-in-scope": {
            const refEdges = opts.allEdges.filter(
              (e) => e.edge_type === rule.edge_type && populationIds.has(e.from_id),
            );
            for (const e of refEdges) {
              if (!populationIds.has(e.to_id)) {
                violations.push({
                  rule_id: loaded.rule_id,
                  kind: rule.kind,
                  severity: "error",
                  reason:
                    loaded.reason ??
                    `\`${rule.edge_type}\` from ${e.from_id} must resolve to a node in the same scope; ${e.to_id} is outside it.`,
                });
              }
            }
            break;
          }
        }
        break;
      }
    }
  }
  return violations;
}

// ─── v7 helpers ──────────────────────────────────────────────────────────

function resolveScopeRef(scope_ref: string, ruleScopeId: string | undefined): string | null {
  if (scope_ref === "$capture_scope") return ruleScopeId ?? null;
  return scope_ref;
}

function nodesInScope(
  index: Map<string, Entity[]> | undefined,
  scopeId: string,
): Entity[] {
  if (!index) return [];
  return index.get(scopeId) ?? [];
}

function matchesWhere(entity: Entity, where: WithinScopeWhere | undefined): boolean {
  if (!where) return true;
  const rec = entity as unknown as Record<string, unknown>;
  if (where.node_type && entity.node_type !== where.node_type) return false;
  if (where.kind !== undefined) {
    const actual = rec.kind;
    if (typeof actual !== "string" || actual !== where.kind) return false;
  }
  if (Array.isArray(where.lifecycle) && where.lifecycle.length > 0) {
    const lc = rec.lifecycle;
    if (typeof lc !== "string" || !where.lifecycle.includes(lc as Lifecycle)) return false;
  }
  return true;
}

function describeWhere(where: WithinScopeWhere | undefined): string {
  if (!where) return "";
  const parts: string[] = [];
  if (where.kind) parts.push(`kind=${where.kind}`);
  if (Array.isArray(where.lifecycle) && where.lifecycle.length > 0)
    parts.push(`lifecycle ∈ {${where.lifecycle.join(",")}}`);
  return parts.length > 0 ? ` where ${parts.join(", ")}` : "";
}

function compareCount(actual: number, comparator: string, n: number): boolean {
  switch (comparator) {
    case "==":
      return actual === n;
    case "!=":
      return actual !== n;
    case ">":
      return actual > n;
    case ">=":
      return actual >= n;
    case "<":
      return actual < n;
    case "<=":
      return actual <= n;
    default:
      return true;
  }
}

function typePrefix(id: string): string {
  const idx = id.indexOf("_");
  return idx === -1 ? "" : id.slice(0, idx);
}

/**
 * Compute the effective `gated_by` rule-id set for a scope by walking
 * ancestors (via the common `scopes` parent edge) and subtracting each
 * scope's `excluded_rules`. Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * `scopeIndex` is `scope_id → Scope`. The walker stops on the first
 * scope whose ancestors are missing from the index (defensive — a
 * partial index returns a partial set rather than throwing).
 */
export function computeEffectiveGatedBy(
  scope: Scope,
  scopeIndex: Map<string, Scope>,
): string[] {
  const seen = new Set<string>();
  const collected = new Set<string>();
  const excluded = new Set<string>();

  function walk(s: Scope): void {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    for (const r of s.gated_by ?? []) collected.add(r);
    for (const r of s.excluded_rules ?? []) excluded.add(r);
    for (const parentId of s.scopes ?? []) {
      const parent = scopeIndex.get(parentId);
      if (parent) walk(parent);
    }
  }
  walk(scope);

  return Array.from(collected).filter((r) => !excluded.has(r));
}

/**
 * Compute the effective `default_node_lifecycle` for a scope: the
 * scope's own value if set, else the nearest ancestor's value, else
 * undefined. Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG).
 */
export function computeEffectiveDefaultLifecycle(
  scope: Scope,
  scopeIndex: Map<string, Scope>,
): Lifecycle | undefined {
  const seen = new Set<string>();

  function walk(s: Scope): Lifecycle | undefined {
    if (seen.has(s.id)) return undefined;
    seen.add(s.id);
    if (s.default_node_lifecycle) return s.default_node_lifecycle;
    for (const parentId of s.scopes ?? []) {
      const parent = scopeIndex.get(parentId);
      if (!parent) continue;
      const result = walk(parent);
      if (result) return result;
    }
    return undefined;
  }
  return walk(scope);
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

export function shouldRunAuthoringRuleForEntity(opts: {
  ruleScopeId: string;
  /**
   * Predicate kind, for predicates whose semantics demand entity-scope
   * membership even when they live on Global. `requires_node_type` is
   * the only such case today — it asks "is the entity claiming this
   * scope of the right type?" — and the answer is irrelevant for
   * entities that don't claim the scope. Without this gate, a
   * `requires_node_type: [rule]` rule on Global would block every
   * non-Rule capture in the Doco, not just non-Rule captures that try
   * to claim Global. Other predicates (`probabilistic`,
   * `requires_field`, `requires_edge`, `mandatory_scope`) are
   * Doco-wide invariants when authored on Global, so they keep the
   * always-fire semantics.
   */
  predicateKind?: string;
  globalScopeId?: string | null;
  entityScopes: string[];
}): boolean {
  if (opts.predicateKind === "requires_node_type") {
    return opts.entityScopes.includes(opts.ruleScopeId);
  }
  if (opts.globalScopeId && opts.ruleScopeId === opts.globalScopeId) return true;
  return opts.entityScopes.includes(opts.ruleScopeId);
}

/**
 * Legacy fallback for the "only Rule nodes belong to Global" check. The
 * canonical enforcement is now the `requires_node_type` authoring rule
 * seeded into every Doco's Global scope at create time, which fires
 * through the normal rules engine on every capture. This helper survives
 * for the PATCH path only, which doesn't currently load + evaluate
 * authoring rules. Once PATCH is wired through `evaluateScopeRules`,
 * delete this function.
 */
export function globalScopeMembershipViolation(opts: {
  entityNodeType: string;
  entityScopes: string[];
  globalScopeId?: string | null;
  globalScopeName?: string;
}): string | null {
  const { globalScopeId } = opts;
  if (!globalScopeId || !opts.entityScopes.includes(globalScopeId)) return null;
  if (opts.entityNodeType === "rule") return null;
  const name = opts.globalScopeName ?? "global";
  return `Only Rule nodes may belong to the ${name} scope. Put project content in a project-specific scope; Global is reserved for the rules that govern the Doco.`;
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
