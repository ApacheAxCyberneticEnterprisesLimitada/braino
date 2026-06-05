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
 *   - deterministic → engine-checked via `predicate.sub_kind`:
 *       requires_edge, limits_edge, forbids_edge,
 *       requires_field, forbids_field, unique_field,
 *       requires_node_type, requires_entity_type,
 *       requires_field_resolves_to_principal, graph-completeness
 *     (and the edge-scoped `requires_edge_type` allowlist, enforced on edge
 *      creation by `evaluateEdgePolicies`, not on node candidates)
 *
 * Per-policy filters:
 *   - `when_node_type` (on the predicate)
 *   - `fires_when_node_lifecycle` (on the policy wrapper)
 */

import type { NodeType } from "./branded.js";
import type { DeterministicSubKind, Lifecycle, PolicyKind, PolicyPredicate } from "./entities.js";

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

function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function entityTypeFromId(id: string): string {
  const i = id.lastIndexOf("_");
  return i <= 0 ? "" : id.slice(0, i);
}

/**
 * Policy records are Doco-scoped metadata; the membership gates
 * (`requires_node_type` / `requires_entity_type`) let them pass without
 * forcing each template to list `policy` as domain content.
 */
function isPolicyMetadataCandidate(candidate: CandidateFields): boolean {
  return entityTypeFromId(candidate.id) === "policy";
}

function comparableFieldValue(value: unknown, caseFold: boolean): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.normalize("NFKC");
  return caseFold ? normalized.toLowerCase() : normalized;
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
    const pred = p.predicate;
    // Deterministic edge-type allowlist — always applies (structural gate).
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
    if (p.kind !== "probabilistic" || !includeProbabilistic) continue;
    if (!("edge_type" in pred) || !("agent_instruction" in pred)) continue;
    if (pred.edge_type !== edge.edge_type) continue;
    if (pred.from_node_type !== undefined && pred.from_node_type !== edge.from_node_type) continue;
    if (pred.to_node_type !== undefined && pred.to_node_type !== edge.to_node_type) continue;
    violations.push({
      policy_id: p.policy_id,
      kind: "probabilistic",
      on_violation: p.on_violation ?? "block",
      reason: pred.agent_instruction,
      pending_spec: pred.agent_instruction,
    });
  }
  return violations;
}

function evaluatePredicate(p: LoadedPolicy, opts: EvaluateOpts): Violation | null {
  const { candidate } = opts;
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

  // Deterministic — dispatch on the predicate's sub_kind.
  if (!("sub_kind" in pred)) return null;

  const fail = (reason: string): Violation => ({
    policy_id: p.policy_id,
    kind: "deterministic",
    sub_kind: pred.sub_kind,
    on_violation: onViolation,
    reason,
  });

  switch (pred.sub_kind) {
    case "requires_edge": {
      // Endpoint-type exemption: a candidate already participating in an
      // `edge_type` edge whose OTHER end is `exempt_when_other_node_type` is
      // excused — e.g. the accountable process owner (`attributed_to` from an
      // Intent) is exempt from the per-step actor-coverage gate. Replaces the
      // old role-based exemption now that roles are gone.
      if (pred.exempt_when_other_node_type) {
        const exempt = opts.edges.some((s) => {
          if (s.edge_type !== pred.edge_type) return false;
          if (s.from_id === candidate.id)
            return entityTypeFromId(s.to_id) === pred.exempt_when_other_node_type;
          if (s.to_id === candidate.id)
            return entityTypeFromId(s.from_id) === pred.exempt_when_other_node_type;
          return false;
        });
        if (exempt) return null;
      }
      const direction = pred.direction ?? "outgoing";
      const pool =
        direction === "incoming"
          ? opts.edges.filter((s) => s.to_id === candidate.id)
          : opts.candidateEdges;
      const matches = pool.filter((s) => {
        if (s.edge_type !== pred.edge_type) return false;
        if (pred.target_node_type) {
          const otherEnd = direction === "incoming" ? s.from_id : s.to_id;
          return entityTypeFromId(otherEnd) === pred.target_node_type;
        }
        return true;
      });
      const min = pred.min_count && pred.min_count > 0 ? pred.min_count : 1;
      if (matches.length >= min) return null;
      const dir = direction === "incoming" ? "incoming " : "";
      const target = pred.target_node_type
        ? `${direction === "incoming" ? " from" : " to"} a ${pred.target_node_type}`
        : "";
      const count = min > 1 ? ` (need ≥${min}, have ${matches.length})` : "";
      return fail(`missing required ${dir}\`${pred.edge_type}\` edge${target}${count}`);
    }
    case "limits_edge": {
      // Ceiling check — the dual of requires_edge. Count the candidate's
      // matching edges (by edge_type, optionally to target_node_type) on the
      // chosen side and fail when there are MORE than `max_count`.
      const direction = pred.direction ?? "outgoing";
      const pool =
        direction === "incoming"
          ? opts.edges.filter((s) => s.to_id === candidate.id)
          : opts.candidateEdges;
      const matches = pool.filter((s) => {
        if (s.edge_type !== pred.edge_type) return false;
        if (pred.target_node_type) {
          const otherEnd = direction === "incoming" ? s.from_id : s.to_id;
          return entityTypeFromId(otherEnd) === pred.target_node_type;
        }
        return true;
      });
      const max = pred.max_count && pred.max_count > 0 ? pred.max_count : 1;
      if (matches.length <= max) return null;
      const dir = direction === "incoming" ? "incoming " : "";
      const target = pred.target_node_type
        ? `${direction === "incoming" ? " from" : " to"} a ${pred.target_node_type}`
        : "";
      return fail(
        `carries ${matches.length} ${dir}\`${pred.edge_type}\` edges${target} (max ${max})`,
      );
    }
    case "forbids_edge": {
      const offender = opts.candidateEdges.find((s) => {
        if (s.edge_type !== pred.edge_type) return false;
        if (pred.target_node_type) {
          return entityTypeFromId(s.to_id) === pred.target_node_type;
        }
        return true;
      });
      if (!offender) return null;
      const target = pred.target_node_type ? ` to a ${pred.target_node_type}` : "";
      return fail(`carries a forbidden \`${pred.edge_type}\` edge${target}`);
    }
    case "requires_field": {
      const missing = pred.fields.filter((f) => !isNonEmpty(candidate[f]));
      if (missing.length === 0) return null;
      return fail(`missing required field(s): ${missing.map((m) => `\`${m}\``).join(", ")}`);
    }
    case "forbids_field": {
      const present = pred.fields.filter((f) => isNonEmpty(candidate[f]));
      if (present.length === 0) return null;
      return fail(`carries forbidden field(s): ${present.map((m) => `\`${m}\``).join(", ")}`);
    }
    case "forbids_field_pattern": {
      let re: RegExp;
      try {
        re = new RegExp(pred.pattern, pred.flags ?? "i");
      } catch {
        // A malformed pattern is an authoring bug in the policy, not in the
        // candidate — fail open rather than block every write on a bad regex.
        return null;
      }
      const hit = pred.fields.find((f) => {
        const v = candidate[f];
        return typeof v === "string" && re.test(v);
      });
      if (!hit) return null;
      return fail(`field \`${hit}\` contains forbidden pattern /${pred.pattern}/`);
    }
    case "flow-wiring": {
      const isInitial =
        pred.initial_when !== undefined &&
        candidate[pred.initial_when.field] === pred.initial_when.equals;
      const isTerminal =
        pred.terminal_when !== undefined &&
        candidate[pred.terminal_when.field] === pred.terminal_when.equals;
      const incoming = opts.edges.filter(
        (s) => s.to_id === candidate.id && s.edge_type === pred.edge_type,
      );
      const outgoing = opts.candidateEdges.filter((s) => s.edge_type === pred.edge_type);
      const problems: string[] = [];
      // Reachable: a non-initial flow node needs ≥1 incoming edge.
      if (!isInitial && incoming.length === 0) {
        problems.push(`no incoming \`${pred.edge_type}\` (unreachable)`);
      }
      // Leads somewhere: a non-terminal flow node needs ≥1 outgoing edge…
      if (!isTerminal && outgoing.length === 0) {
        problems.push(`no outgoing \`${pred.edge_type}\` (dead end)`);
      }
      // …and a terminal node must NOT carry one — it ends the path.
      if (isTerminal && outgoing.length > 0) {
        problems.push(`terminal node must have no outgoing \`${pred.edge_type}\``);
      }
      if (problems.length === 0) return null;
      return fail(`broken sequence flow: ${problems.join("; ")}`);
    }
    case "unique_field": {
      const candidateValue = comparableFieldValue(candidate[pred.field], Boolean(pred.case_fold));
      if (candidateValue === null) return null;
      const duplicate = opts.population.find((n) => {
        if (n.id === candidate.id || n.lifecycle === "retired") return false;
        const when = pred.when_node_type;
        if (when && when.length > 0) {
          if (!n.node_type || !when.includes(n.node_type)) return false;
        }
        return comparableFieldValue(n[pred.field], Boolean(pred.case_fold)) === candidateValue;
      });
      if (!duplicate) return null;
      const rawValue = candidate[pred.field];
      const original = typeof rawValue === "string" ? rawValue.trim() : "";
      const value = original ? ` value \`${original}\`` : "";
      return fail(`\`${pred.field}\`${value} duplicates active ${duplicate.id}`);
    }
    case "requires_node_type": {
      if (isPolicyMetadataCandidate(candidate)) return null;
      const ct = candidate.node_type;
      if (ct && pred.node_types.includes(ct)) return null;
      return fail(
        `node_type \`${ct ?? "<missing>"}\` not in allowlist [${pred.node_types.map((n) => `\`${n}\``).join(", ")}]`,
      );
    }
    case "requires_edge_type":
      // Edge-type allowlist is an EDGE-scoped gate, enforced on edge creation by
      // `evaluateEdgePolicies`. It never constrains a node candidate, so node
      // evaluation skips it.
      return null;
    case "requires_entity_type": {
      if (isPolicyMetadataCandidate(candidate)) return null;
      const fromId = entityTypeFromId(candidate.id);
      if (fromId && (pred.entity_types as readonly string[]).includes(fromId)) return null;
      return fail(
        `entity_type \`${fromId || "<unknown>"}\` not in allowlist [${pred.entity_types.map((e) => `\`${e}\``).join(", ")}]`,
      );
    }
    case "requires_field_resolves_to_principal": {
      const value = candidate[pred.field];
      if (typeof value !== "string" || value.length === 0) {
        return fail(`\`${pred.field}\` is empty — expected a Principal id`);
      }
      if (!opts.principals.has(value)) {
        return fail(`\`${pred.field}\` = \`${value}\` does not resolve to a known Principal`);
      }
      return null;
    }
    case "graph-completeness": {
      const list = candidate[pred.list_field];
      if (!Array.isArray(list) || list.length === 0) return null;
      const missing: string[] = [];
      for (const id of list) {
        if (typeof id !== "string") continue;
        // Find an incoming node of the required type whose
        // `incoming_field_must_match` equals this id AND that has a
        // matching edge_type pointing at the candidate.
        const covered = opts.population.some((n) => {
          if (n.node_type !== pred.incoming_node_type) return false;
          if (n[pred.incoming_field_must_match] !== id) return false;
          // Verify the edge exists: incoming.id --edge_type--> candidate.id
          return opts.edges.some(
            (s) => s.from_id === n.id && s.to_id === candidate.id && s.edge_type === pred.edge_type,
          );
        });
        if (!covered) missing.push(id);
      }
      if (missing.length === 0) return null;
      return fail(
        `\`${pred.list_field}\` entries lack a matching incoming \`${pred.edge_type}\` from a \`${pred.incoming_node_type}\`: ${missing.map((m) => `\`${m}\``).join(", ")}`,
      );
    }
  }
}
