/**
 * Authoring policies evaluator — pure module.
 *
 * Walks the doco's `policies` directly. Policies apply to the whole doco.
 *
 * Inputs in, violations out. No IO, no LLM. The caller (web layer) is
 * responsible for:
 *   - loading the doco's policies, principals, edges, and population
 *   - passing the candidate's active outgoing edges
 *   - resolving probabilistic violations via an LLM judge (the engine
 *     just emits them as `pending` violations with the agent instruction
 *     attached)
 *
 * Dispatch is on the policy's standalone `kind`:
 *   - suggestion    → advisory; never produces a violation here.
 *   - probabilistic → emitted as a pending violation (LLM judge resolves it).
 *   - deterministic → delegated to `DETERMINISTIC_CHECKS[sub_kind].evaluate`,
 *     the single registry of structural checks (see `deterministic-checks.ts`).
 *     The edge-scoped `requires_edge_type` allowlist is enforced on edge
 *     creation by `evaluateEdgePolicies`, not on node candidates.
 *
 * Per-policy filters:
 *   - `when_node_type` (on the predicate)
 *   - `fires_when_node_lifecycle` (on the policy wrapper)
 */

import type { NodeType } from "./branded.js";
import { DETERMINISTIC_CHECKS } from "./deterministic-checks.js";
import type { CheckEvalContext } from "./deterministic-checks.js";
import type {
  DeterministicPredicate,
  DeterministicSubKind,
  Lifecycle,
  PolicyKind,
  PolicyPredicate,
} from "./entities.js";

/**
 * Candidate node / policy fields the engine evaluates. Just the fields-as-bag
 * the persister would write — the engine doesn't care about the full Entity
 * union, only that it has an id, a node_type, and optionally a lifecycle.
 */
export type CandidateFields = Record<string, unknown> & {
  id: string;
  node_type?: NodeType;
  lifecycle?: Lifecycle;
};

/** One edge in the doco. */
export interface EngineEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
}

/**
 * A policy loaded from the doco, with the bits the engine consults.
 */
export interface LoadedPolicy {
  /** Id of the originating policy — back-pointer for the UI. */
  policy_id: string;
  /** Standalone classifier — drives dispatch. */
  kind: PolicyKind;
  predicate: PolicyPredicate;
  /** Defaults to "block" when undefined. */
  on_violation?: "block" | "warn" | "log";
  /**
   * Skip this policy unless the candidate's `lifecycle` is in this
   * list. Empty / undefined means "fires regardless of lifecycle".
   * Lets completeness policies wait for `accepted`.
   */
  fires_when_node_lifecycle?: Lifecycle[];
}

export interface Violation {
  policy_id: string;
  /** The policy's kind — `deterministic` or `probabilistic` (suggestions never violate). */
  kind: PolicyKind;
  /** For deterministic violations: which engine check fired. */
  sub_kind?: DeterministicSubKind;
  /** "block" propagates as a hard error; "warn" is reported; "log" is silent. */
  on_violation: "block" | "warn" | "log";
  reason: string;
  /** For probabilistic violations: the agent instruction to feed an LLM judge. */
  pending_spec?: string;
}

/**
 * Minimal principal index — id → present. The engine only needs to
 * confirm existence; the person/agent split lives on User now.
 */
export type PrincipalIndex = Set<string>;

export interface EvaluateOpts {
  /** The candidate's fields (NOT yet persisted). */
  candidate: CandidateFields;
  /** All predicate-bearing policies loaded from the doco. */
  policies: LoadedPolicy[];
  /**
   * Active outgoing edges for the candidate, loaded from the edge table.
   */
  candidateEdges: EngineEdge[];
  /**
   * Existing edges in the doco (other nodes' edges). Used by
   * `graph-completeness` to look up incoming edges.
   */
  edges: EngineEdge[];
  /** Principals known to the host. */
  principals: PrincipalIndex;
  /**
   * Fields of OTHER nodes in the doco (i.e., everything that isn't
   * the candidate). Used by `graph-completeness` to look up
   * `incoming_field_must_match` values on the producing nodes.
   */
  population: CandidateFields[];
}

/**
 * Evaluate every loaded policy against the candidate. Returns one
 * `Violation` per failing policy (zero if all pass). The caller
 * decides what to do with each violation based on `on_violation`.
 */
export function evaluatePolicies(opts: EvaluateOpts): Violation[] {
  const { candidate, policies } = opts;
  const violations: Violation[] = [];
  for (const p of policies) {
    if (!policyFiresFor(p, candidate)) continue;
    const v = evaluatePredicate(p, opts);
    if (v) violations.push(v);
  }
  return violations;
}

export function policyFiresFor(p: LoadedPolicy, candidate: CandidateFields): boolean {
  const lifecycles = p.fires_when_node_lifecycle;
  if (lifecycles && lifecycles.length > 0) {
    if (!candidate.lifecycle || !lifecycles.includes(candidate.lifecycle)) return false;
  }
  // `when_node_type` filter — only on predicates that carry one. Membership
  // gates (requires_node_type / requires_entity_type) carry none, so they
  // fire against every candidate.
  const pred = p.predicate;
  const when = "when_node_type" in pred ? pred.when_node_type : undefined;
  if (when && when.length > 0) {
    const ct = candidate.node_type;
    if (!ct || !when.includes(ct)) return false;
  }
  return true;
}

/** A newly-created edge, as the edge evaluator sees it. */
export interface EdgeCandidate {
  edge_type: string;
  /** Endpoint node types (entity-type prefixes), when known. */
  from_node_type?: string;
  to_node_type?: string;
}

/**
 * Whether an edge-scoped policy applies to a given edge. The single source of
 * truth shared by `evaluateEdgePolicies` (which produces the violations) and
 * `runEdgeAuthoringPolicies` (which counts how many policies were evaluated, so
 * the capture footer can report "N authoring policies passed"). Two kinds apply:
 * the deterministic `requires_edge_type` allowlist (a structural gate, so it
 * always applies — even for a `drafting` edge), and edge-scoped `probabilistic`
 * quality checks whose scoping (`edge_type`, optional endpoint node types)
 * matches the edge (skipped for a `drafting` edge when `includeProbabilistic`
 * is false). Node-scoped policies never apply.
 */
export function edgePolicyAppliesToEdge(
  p: LoadedPolicy,
  edge: EdgeCandidate,
  includeProbabilistic: boolean,
): boolean {
  const pred = p.predicate;
  if (p.kind === "deterministic" && "sub_kind" in pred && pred.sub_kind === "requires_edge_type") {
    return true;
  }
  if (p.kind !== "probabilistic" || !includeProbabilistic) return false;
  if (!("edge_type" in pred) || !("agent_instruction" in pred)) return false;
  if (pred.edge_type !== edge.edge_type) return false;
  if (pred.from_node_type !== undefined && pred.from_node_type !== edge.from_node_type)
    return false;
  if (pred.to_node_type !== undefined && pred.to_node_type !== edge.to_node_type) return false;
  return true;
}

/**
 * Evaluate edge-scoped policies against a newly-created edge. Two kinds fire
 * here:
 *
 *   - `requires_edge_type` (deterministic): the Doco-wide edge-type allowlist.
 *     An edge whose `edge_type` is not permitted yields a resolved deterministic
 *     violation. It is a structural membership gate, so it always applies —
 *     even when `includeProbabilistic` is false (a `drafting` edge).
 *   - edge-scoped `probabilistic`: one pending violation per policy whose edge
 *     scoping (`edge_type`, optional endpoint node types) matches; the caller
 *     resolves each with the LLM judge, handing it BOTH endpoint nodes. These
 *     are quality checks, so they are skipped when `includeProbabilistic` is
 *     false (a `drafting` edge is exempt, mirroring node lifecycle exemptions).
 *
 * Node-scoped policies are ignored here.
 */
export function evaluateEdgePolicies(opts: {
  edge: EdgeCandidate;
  policies: LoadedPolicy[];
  /** Include edge-scoped probabilistic quality checks. Default true; pass false for a `drafting` edge. */
  includeProbabilistic?: boolean;
}): Violation[] {
  const { edge, policies } = opts;
  const includeProbabilistic = opts.includeProbabilistic ?? true;
  const violations: Violation[] = [];
  for (const p of policies) {
    if (!edgePolicyAppliesToEdge(p, edge, includeProbabilistic)) continue;
    const pred = p.predicate;
    // Deterministic edge-type allowlist — fires only when the type is barred.
    if (
      p.kind === "deterministic" &&
      "sub_kind" in pred &&
      pred.sub_kind === "requires_edge_type"
    ) {
      if (!pred.edge_types.includes(edge.edge_type)) {
        violations.push({
          policy_id: p.policy_id,
          kind: "deterministic",
          sub_kind: "requires_edge_type",
          on_violation: p.on_violation ?? "block",
          reason: `edge_type \`${edge.edge_type}\` not in allowlist [${pred.edge_types.map((e) => `\`${e}\``).join(", ")}]`,
        });
      }
      continue;
    }
    // Edge-scoped probabilistic — applicability guaranteed the scoping matches.
    if ("agent_instruction" in pred) {
      violations.push({
        policy_id: p.policy_id,
        kind: "probabilistic",
        on_violation: p.on_violation ?? "block",
        reason: pred.agent_instruction,
        pending_spec: pred.agent_instruction,
      });
    }
  }
  return violations;
}

function evaluatePredicate(p: LoadedPolicy, opts: EvaluateOpts): Violation | null {
  const onViolation = p.on_violation ?? "block";
  const pred = p.predicate;

  // Suggestions are advisory — surfaced to agents elsewhere, never enforced.
  if (p.kind === "suggestion") return null;

  // Probabilistic — engine doesn't run the LLM judge. Emit a pending
  // violation with the agent instruction so the caller can resolve it.
  if (p.kind === "probabilistic") {
    if (!("agent_instruction" in pred)) return null;
    // Edge-scoped probabilistic predicates fire on edge creation, not on a
    // node candidate — they're owned by `evaluateEdgePolicies`. Skip them here
    // so node evaluation never emits them.
    if ("edge_type" in pred) return null;
    return {
      policy_id: p.policy_id,
      kind: "probabilistic",
      on_violation: onViolation,
      reason: pred.agent_instruction,
      pending_spec: pred.agent_instruction,
    };
  }

  // Deterministic — delegate to the registry, the one home for each check.
  if (!("sub_kind" in pred)) return null;
  const evaluate = DETERMINISTIC_CHECKS[pred.sub_kind].evaluate as (
    predicate: DeterministicPredicate,
    ctx: CheckEvalContext,
  ) => string | null;
  const reason = evaluate(pred, opts);
  if (reason === null) return null;
  return {
    policy_id: p.policy_id,
    kind: "deterministic",
    sub_kind: pred.sub_kind,
    on_violation: onViolation,
    reason,
  };
}
