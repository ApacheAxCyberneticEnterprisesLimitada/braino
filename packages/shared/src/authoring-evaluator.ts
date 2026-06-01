/**
 * Authoring policies evaluator — pure module.
 *
 * Walks the doco's `node_authoring_policies` directly. Policies
 * apply to the whole doco.
 *
 * Inputs in, violations out. No IO, no LLM. The caller (web layer) is
 * responsible for:
 *   - loading the doco's policies, principals, edges, and population
 *   - passing the candidate's active outgoing edges
 *   - resolving probabilistic violations via an LLM judge (the engine
 *     just emits them as `pending` violations with the spec attached)
 *
 * Predicate kinds handled:
 *   - requires_edge, forbids_edge
 *   - requires_field, forbids_field, unique_field
 *   - requires_node_type, requires_entity_type
 *   - requires_field_resolves_to_principal
 *   - graph-completeness
 *   - probabilistic   → emitted as pending violation
 *   - descriptive     → no-op (records intent only)
 *
 * Per-predicate filters:
 *   - `when_node_type` (on the predicate)
 *   - `fires_when_node_lifecycle` (on the policy wrapper)
 */

import type { NodeType } from "./branded.js";
import type { AuthoringPredicate, Lifecycle } from "./entities.js";

/**
 * Candidate node / policy fields the engine evaluates. Just
 * the fields-as-bag the persister would write — the engine doesn't care
 * about the full Entity union, only that it has an id, a node_type
 * (or policy_kind), and optionally a lifecycle.
 */
export type CandidateFields = Record<string, unknown> & {
  id: string;
  node_type?: NodeType;
  policy_kind?: "guidance" | "node_authoring";
  lifecycle?: Lifecycle;
};

/** One edge in the doco. */
export interface EngineEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
}

/**
 * A node_authoring_policy loaded from the doco, with the bits the
 * engine consults.
 */
export interface LoadedPolicy {
  /** Id of the originating policy — back-pointer for the UI. */
  policy_id: string;
  /** The one-line rule statement — surfaces in violation messages. */
  policy: string;
  predicate: AuthoringPredicate;
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
  predicate_kind: AuthoringPredicate["kind"];
  /** "block" propagates as a hard error; "warn" is reported; "log" is silent. */
  on_violation: "block" | "warn" | "log";
  reason: string;
  /** For probabilistic violations: the spec to feed an LLM judge. */
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

const NODE_TYPE_PREDICATE_KINDS: ReadonlySet<AuthoringPredicate["kind"]> = new Set([
  "requires_edge",
  "forbids_edge",
  "requires_field",
  "forbids_field",
  "unique_field",
  "probabilistic",
  "graph-completeness",
  "requires_field_resolves_to_principal",
  "descriptive",
]);

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
  // `when_node_type` filter — only on predicates that carry one.
  const pred = p.predicate;
  if (NODE_TYPE_PREDICATE_KINDS.has(pred.kind)) {
    const when = "when_node_type" in pred ? pred.when_node_type : undefined;
    if (when && when.length > 0) {
      const ct = candidate.node_type;
      if (!ct || !when.includes(ct)) return false;
    }
  }
  return true;
}

function evaluatePredicate(p: LoadedPolicy, opts: EvaluateOpts): Violation | null {
  const { candidate } = opts;
  const onViolation = p.on_violation ?? "block";
  const pred = p.predicate;

  const fail = (reason: string, extra?: { pending_spec?: string }): Violation => ({
    policy_id: p.policy_id,
    predicate_kind: pred.kind,
    on_violation: onViolation,
    reason: `${p.policy} — ${reason}`,
    ...(extra?.pending_spec ? { pending_spec: extra.pending_spec } : {}),
  });

  switch (pred.kind) {
    case "requires_edge": {
      const wanted = opts.candidateEdges.find((s) => {
        if (s.edge_type !== pred.edge_type) return false;
        if (pred.target_node_type) {
          return entityTypeFromId(s.to_id) === pred.target_node_type;
        }
        return true;
      });
      if (wanted) return null;
      const target = pred.target_node_type ? ` to a ${pred.target_node_type}` : "";
      return fail(`missing required \`${pred.edge_type}\` edge${target}`);
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
      const ct = candidate.node_type;
      if (ct && pred.node_types.includes(ct)) return null;
      return fail(
        `node_type \`${ct ?? "<missing>"}\` not in allowlist [${pred.node_types.map((n) => `\`${n}\``).join(", ")}]`,
      );
    }
    case "requires_entity_type": {
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
    case "probabilistic": {
      // Engine doesn't run the LLM judge — emit a pending violation
      // with the spec so the caller can decide synchronously or async.
      return {
        policy_id: p.policy_id,
        predicate_kind: pred.kind,
        on_violation: onViolation,
        reason: `${p.policy} — pending LLM judge`,
        pending_spec: pred.spec,
      };
    }
    case "descriptive": {
      // Recorded-but-not-enforced. No violation.
      return null;
    }
  }
}
