/**
 * Authoring primitives evaluator — pure module.
 *
 * Walks the doco's `neuron_authoring_primitives` directly. Primitives
 * apply to the whole doco.
 *
 * Inputs in, violations out. No IO, no LLM. The caller (web layer) is
 * responsible for:
 *   - loading the doco's primitives, principals, synapses, and population
 *   - deriving the candidate's outgoing synapses from its structured fields
 *     (via `deriveSynapses` from `@doco/index`)
 *   - resolving probabilistic violations via an LLM judge (the engine
 *     just emits them as `pending` violations with the spec attached)
 *
 * Predicate kinds handled:
 *   - requires_synapse, forbids_synapse
 *   - requires_field, forbids_field
 *   - requires_neuron_type, requires_entity_type
 *   - requires_field_resolves_to_principal
 *   - graph-completeness
 *   - probabilistic   → emitted as pending violation
 *   - descriptive     → no-op (records intent only)
 *
 * Per-predicate filters:
 *   - `when_neuron_type` (on the predicate)
 *   - `fires_when_neuron_lifecycle` (on the primitive wrapper)
 */

import type { NeuronType } from "./branded.js";
import type { AuthoringPredicate, Lifecycle } from "./entities.js";

/**
 * Candidate neuron / primitive fields the engine evaluates. Just
 * the fields-as-bag the persister would write — the engine doesn't care
 * about the full Entity union, only that it has an id, a neuron_type
 * (or primitive_kind), and optionally a lifecycle.
 */
export type CandidateFields = Record<string, unknown> & {
  id: string;
  neuron_type?: NeuronType;
  primitive_kind?: "guidance" | "neuron_authoring";
  lifecycle?: Lifecycle;
};

/** One synapse in the doco. Shape mirrors `Synapse` from `@doco/index`. */
export interface EngineSynapse {
  from_id: string;
  to_id: string;
  synapse_type: string;
}

/**
 * A neuron_authoring_primitive loaded from the doco, with the bits the
 * engine consults.
 */
export interface LoadedPrimitive {
  /** Id of the originating primitive — back-pointer for the UI. */
  primitive_id: string;
  /** Human-readable rule text — surfaces in violation messages. */
  summary: string;
  predicate: AuthoringPredicate;
  /** Defaults to "block" when undefined. */
  on_violation?: "block" | "warn" | "log";
  /**
   * Skip this primitive unless the candidate's `lifecycle` is in this
   * list. Empty / undefined means "fires regardless of lifecycle".
   * Lets completeness primitives wait for `active`.
   */
  fires_when_neuron_lifecycle?: Lifecycle[];
}

export interface Violation {
  primitive_id: string;
  predicate_kind: AuthoringPredicate["kind"];
  /** "block" propagates as a hard error; "warn" is reported; "log" is silent. */
  on_violation: "block" | "warn" | "log";
  reason: string;
  /** For probabilistic violations: the spec to feed an LLM judge. */
  pending_spec?: string;
}

/**
 * Minimal principal index — id → present. The engine only needs to
 * confirm existence; the person/agent split lives on Collaborator now.
 */
export type PrincipalIndex = Set<string>;

export interface EvaluateOpts {
  /** The candidate's fields (NOT yet persisted). */
  candidate: CandidateFields;
  /** All predicate-bearing primitives loaded from the doco. */
  primitives: LoadedPrimitive[];
  /**
   * Synapses derived from the candidate's fields (via
   * `deriveSynapses`). The candidate hasn't been persisted yet so these
   * aren't in the synapses table — pass them explicitly.
   */
  candidateSynapses: EngineSynapse[];
  /**
   * Existing synapses in the doco (other nodes' edges). Used by
   * `graph-completeness` to look up incoming edges.
   */
  synapses: EngineSynapse[];
  /** Principals known to the host. */
  principals: PrincipalIndex;
  /**
   * Fields of OTHER neurons in the doco (i.e., everything that isn't
   * the candidate). Used by `graph-completeness` to look up
   * `incoming_field_must_match` values on the producing neurons.
   */
  population: CandidateFields[];
}

const NEURON_TYPE_PREDICATE_KINDS: ReadonlySet<AuthoringPredicate["kind"]> = new Set([
  "requires_synapse",
  "forbids_synapse",
  "requires_field",
  "forbids_field",
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

/**
 * Evaluate every loaded primitive against the candidate. Returns one
 * `Violation` per failing primitive (zero if all pass). The caller
 * decides what to do with each violation based on `on_violation`.
 */
export function evaluatePrimitives(opts: EvaluateOpts): Violation[] {
  const { candidate, primitives } = opts;
  const violations: Violation[] = [];
  for (const p of primitives) {
    if (!firesFor(p, candidate)) continue;
    const v = evaluatePredicate(p, opts);
    if (v) violations.push(v);
  }
  return violations;
}

function firesFor(p: LoadedPrimitive, candidate: CandidateFields): boolean {
  const lifecycles = p.fires_when_neuron_lifecycle;
  if (lifecycles && lifecycles.length > 0) {
    if (!candidate.lifecycle || !lifecycles.includes(candidate.lifecycle)) return false;
  }
  // `when_neuron_type` filter — only on predicates that carry one.
  const pred = p.predicate;
  if (NEURON_TYPE_PREDICATE_KINDS.has(pred.kind)) {
    const when = "when_neuron_type" in pred ? pred.when_neuron_type : undefined;
    if (when && when.length > 0) {
      const ct = candidate.neuron_type;
      if (!ct || !when.includes(ct)) return false;
    }
  }
  return true;
}

function evaluatePredicate(p: LoadedPrimitive, opts: EvaluateOpts): Violation | null {
  const { candidate } = opts;
  const onViolation = p.on_violation ?? "block";
  const pred = p.predicate;

  const fail = (reason: string, extra?: { pending_spec?: string }): Violation => ({
    primitive_id: p.primitive_id,
    predicate_kind: pred.kind,
    on_violation: onViolation,
    reason: `${p.summary} — ${reason}`,
    ...(extra?.pending_spec ? { pending_spec: extra.pending_spec } : {}),
  });

  switch (pred.kind) {
    case "requires_synapse": {
      const wanted = opts.candidateSynapses.find((s) => {
        if (s.synapse_type !== pred.synapse_type) return false;
        if (pred.target_neuron_type) {
          return entityTypeFromId(s.to_id) === pred.target_neuron_type;
        }
        return true;
      });
      if (wanted) return null;
      const target = pred.target_neuron_type ? ` to a ${pred.target_neuron_type}` : "";
      return fail(`missing required \`${pred.synapse_type}\` synapse${target}`);
    }
    case "forbids_synapse": {
      const offender = opts.candidateSynapses.find((s) => {
        if (s.synapse_type !== pred.synapse_type) return false;
        if (pred.target_neuron_type) {
          return entityTypeFromId(s.to_id) === pred.target_neuron_type;
        }
        return true;
      });
      if (!offender) return null;
      const target = pred.target_neuron_type ? ` to a ${pred.target_neuron_type}` : "";
      return fail(`carries a forbidden \`${pred.synapse_type}\` synapse${target}`);
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
    case "requires_neuron_type": {
      const ct = candidate.neuron_type;
      if (ct && pred.neuron_types.includes(ct)) return null;
      return fail(
        `neuron_type \`${ct ?? "<missing>"}\` not in allowlist [${pred.neuron_types.map((n) => `\`${n}\``).join(", ")}]`,
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
        // Find an incoming neuron of the required type whose
        // `incoming_field_must_match` equals this id AND that has a
        // matching synapse_type pointing at the candidate.
        const covered = opts.population.some((n) => {
          if (n.neuron_type !== pred.incoming_neuron_type) return false;
          if (n[pred.incoming_field_must_match] !== id) return false;
          // Verify the synapse exists: incoming.id --synapse_type--> candidate.id
          return opts.synapses.some(
            (s) =>
              s.from_id === n.id &&
              s.to_id === candidate.id &&
              s.synapse_type === pred.synapse_type,
          );
        });
        if (!covered) missing.push(id);
      }
      if (missing.length === 0) return null;
      return fail(
        `\`${pred.list_field}\` entries lack a matching incoming \`${pred.synapse_type}\` from a \`${pred.incoming_neuron_type}\`: ${missing.map((m) => `\`${m}\``).join(", ")}`,
      );
    }
    case "probabilistic": {
      // Engine doesn't run the LLM judge — emit a pending violation
      // with the spec so the caller can decide synchronously or async.
      return {
        primitive_id: p.primitive_id,
        predicate_kind: pred.kind,
        on_violation: onViolation,
        reason: `${p.summary} — pending LLM judge`,
        pending_spec: pred.spec,
      };
    }
    case "descriptive": {
      // Recorded-but-not-enforced. No violation.
      return null;
    }
  }
}
