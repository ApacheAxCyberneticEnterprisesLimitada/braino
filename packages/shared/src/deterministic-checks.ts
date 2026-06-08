/**
 * The deterministic check registry — the single source of truth for every
 * structural check the authoring engine understands.
 *
 * Each `sub_kind` has exactly one entry here carrying everything that used to be
 * fanned out across the codebase:
 *   - `label`    → the human headline (was `SUB_KIND_HEADLINE`)
 *   - `fields`   → a declarative field schema that drives the edit form's inputs,
 *                  the form → predicate builder, persistence-time validation, and
 *                  the "labeled parts" rendering — so all four derive from one place
 *   - `evaluate` → the engine check itself (was a `switch` arm in the evaluator)
 *
 * Adding a new check is now a single localized edit: add one entry. The menu,
 * the form, the parser, the validator, the human rendering, and the engine all
 * pick it up automatically, and the compiler enforces that every `sub_kind` in
 * `DeterministicPredicate` has an entry.
 */

import { EDGE_TYPES } from "./access-types.js";
import type { CandidateFields, EngineEdge, PrincipalIndex } from "./authoring-evaluator.js";
import type { DeterministicPredicate, DeterministicSubKind } from "./entities.js";

/** Everything an engine check needs about the doco around the candidate. */
export interface CheckEvalContext {
  /** The candidate's fields (NOT yet persisted). */
  candidate: CandidateFields;
  /** Active outgoing edges for the candidate. */
  candidateEdges: EngineEdge[];
  /** Existing edges in the doco (other nodes' edges). */
  edges: EngineEdge[];
  /** Principals known to the host. */
  principals: PrincipalIndex;
  /** Fields of OTHER nodes in the doco. */
  population: CandidateFields[];
}

// ── Field schema ────────────────────────────────────────────────────────────

/**
 * How a predicate field is entered, stored, and validated. One control per
 * shape the predicates use; the form renderer, the builder, the validator, and
 * the parts renderer each switch on this small vocabulary instead of on the
 * sub_kind.
 */
export type FieldControl =
  | "edge-type" // a single first-class edge type — validated against EDGE_TYPES
  | "node-type" // a single node type
  | "direction" // "outgoing" | "incoming"
  | "text" // a free string
  | "number" // a non-negative integer
  | "checkbox" // a boolean — stored only when true
  | "node-type-csv" // comma-separated node types
  | "entity-type-csv" // comma-separated entity types
  | "edge-type-csv" // comma-separated edge types (e.g. an allowlist's contents)
  | "field-csv" // comma-separated arbitrary field names
  | "condition"; // a `{ field, equals }` pair, from `${name}_field` / `${name}_equals`

export interface FieldSpec {
  /** Predicate key — also the base form input name. */
  name: string;
  control: FieldControl;
  /** Label shown above the form input. */
  formLabel: string;
  /** Label used when the predicate is rendered as human-readable parts. */
  partLabel: string;
  /** When set, the builder/validator reject the predicate if the field is blank. */
  required?: boolean;
}

/** A check's entry: its label, its field schema, and its engine logic. */
interface CheckSpecFor<K extends DeterministicSubKind> {
  label: string;
  fields: FieldSpec[];
  /** Failure reason, or null when the candidate passes. */
  evaluate(
    predicate: Extract<DeterministicPredicate, { sub_kind: K }>,
    ctx: CheckEvalContext,
  ): string | null;
}

type CheckRegistry = { [K in DeterministicSubKind]: CheckSpecFor<K> };

// ── Engine helpers (used only by the evaluate functions) ─────────────────────

function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Whether the candidate carries a truthy value at ANY of the comma-separated
 * field names. Powers `exempt_when_field_truthy` (skip the check) — one node may
 * be excused by several flags at once (e.g. `exit_point` OR `top_level`).
 */
function anyFieldTruthy(candidate: CandidateFields, fieldList: string | undefined): boolean {
  if (!fieldList) return false;
  return fieldList
    .split(",")
    .map((f) => f.trim())
    .some((f) => f.length > 0 && Boolean(candidate[f]));
}

function entityTypeFromId(id: string): string {
  const i = id.lastIndexOf("_");
  return i <= 0 ? "" : id.slice(0, i);
}

/**
 * Policy records are Doco-scoped metadata; the membership gates
 * (`requires_node_type` / `requires_entity_type`) let them pass without forcing
 * each template to list `policy` as domain content.
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
 * The candidate's matching edges on the chosen side — shared by the floor
 * (`requires_edge`) and ceiling (`limits_edge`) checks, which differ only in how
 * they compare the count.
 */
function directedMatchingEdges(
  pred: { edge_type: string; target_node_type?: string; direction?: "incoming" | "outgoing" },
  ctx: CheckEvalContext,
): { matches: EngineEdge[]; direction: "incoming" | "outgoing" } {
  const direction = pred.direction ?? "outgoing";
  const pool =
    direction === "incoming"
      ? ctx.edges.filter((s) => s.to_id === ctx.candidate.id)
      : ctx.candidateEdges;
  const matches = pool.filter((s) => {
    if (s.edge_type !== pred.edge_type) return false;
    if (pred.target_node_type) {
      const otherEnd = direction === "incoming" ? s.from_id : s.to_id;
      return entityTypeFromId(otherEnd) === pred.target_node_type;
    }
    return true;
  });
  return { matches, direction };
}

// ── The registry ─────────────────────────────────────────────────────────────

const EDGE_TYPE_FIELD: FieldSpec = {
  name: "edge_type",
  control: "edge-type",
  formLabel: "Edge type",
  partLabel: "edge type",
  required: true,
};
const TARGET_NODE_TYPE_FIELD: FieldSpec = {
  name: "target_node_type",
  control: "node-type",
  formLabel: "Target node type (optional)",
  partLabel: "target",
};
const DIRECTION_FIELD: FieldSpec = {
  name: "direction",
  control: "direction",
  formLabel: "Direction (optional)",
  partLabel: "direction",
};
const WHEN_NODE_TYPE_FIELD: FieldSpec = {
  name: "when_node_type",
  control: "node-type-csv",
  formLabel: "When node type (comma-separated, optional)",
  partLabel: "when node type",
};
// The structural "this node is a parent/container" exemption, shared by the
// membership floor (`requires_edge`) and the sequence-flow check
// (`flow-wiring`). The labels spell out the direction so it never reads as if
// the REQUIRED edge were incoming: the check is excused only when the candidate
// is the TARGET of an incoming edge of this type (so it is itself a parent —
// e.g. a top-level Action that its children point at with `has_parent`).
const EXEMPT_WHEN_INCOMING_FIELD: FieldSpec = {
  name: "exempt_when_incoming_edge_type",
  control: "edge-type",
  formLabel:
    "Exempt when the node is the target of an incoming edge of this type — i.e. it is itself a parent/container (optional)",
  partLabel: "exempt when target of incoming",
};

export const DETERMINISTIC_CHECKS: CheckRegistry = {
  requires_edge: {
    label: "Requires edge",
    fields: [
      EDGE_TYPE_FIELD,
      TARGET_NODE_TYPE_FIELD,
      {
        name: "min_count",
        control: "number",
        formLabel: "Minimum count (optional)",
        partLabel: "min count",
      },
      DIRECTION_FIELD,
      {
        name: "exempt_when_other_node_type",
        control: "node-type",
        formLabel: "Exempt when other endpoint is node type (optional)",
        partLabel: "exempt when other",
      },
      EXEMPT_WHEN_INCOMING_FIELD,
      {
        name: "exempt_when_field_truthy",
        control: "text",
        formLabel: "Exempt when field is set (optional)",
        partLabel: "exempt when field set",
      },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      // Field opt-out: a candidate carrying a truthy value at ANY of the named
      // fields (comma-separated) is explicitly excused — an author-set escape
      // hatch, distinct from the structural edge exemptions below. e.g. the
      // sequence-flow reachability floor excuses both a flagged `entry_point`
      // (the start of the flow) and a `top_level` Action (the pool container,
      // not a sequenced step).
      if (anyFieldTruthy(ctx.candidate, pred.exempt_when_field_truthy)) {
        return null;
      }
      // Endpoint-type exemption: a candidate already participating in an
      // `edge_type` edge whose OTHER end is `exempt_when_other_node_type` is
      // excused — e.g. the accountable process owner (`attributed_to` from an
      // Intent) is exempt from the per-step actor-coverage gate.
      if (pred.exempt_when_other_node_type) {
        const exempt = ctx.edges.some((s) => {
          if (s.edge_type !== pred.edge_type) return false;
          if (s.from_id === ctx.candidate.id)
            return entityTypeFromId(s.to_id) === pred.exempt_when_other_node_type;
          if (s.to_id === ctx.candidate.id)
            return entityTypeFromId(s.from_id) === pred.exempt_when_other_node_type;
          return false;
        });
        if (exempt) return null;
      }
      // Container exemption: a candidate that is the TARGET of ≥1 incoming edge
      // of `exempt_when_incoming_edge_type` is a parent/process container, not a
      // per-step member — excuse it from the floor (e.g. a process Action with
      // `has_parent` children needs no `has_parent` of its own).
      if (
        pred.exempt_when_incoming_edge_type &&
        ctx.edges.some(
          (s) =>
            s.to_id === ctx.candidate.id && s.edge_type === pred.exempt_when_incoming_edge_type,
        )
      ) {
        return null;
      }
      const { matches, direction } = directedMatchingEdges(pred, ctx);
      const min = pred.min_count && pred.min_count > 0 ? pred.min_count : 1;
      if (matches.length >= min) return null;
      const dir = direction === "incoming" ? "incoming " : "";
      const target = pred.target_node_type
        ? `${direction === "incoming" ? " from" : " to"} a ${pred.target_node_type}`
        : "";
      const count = min > 1 ? ` (need ≥${min}, have ${matches.length})` : "";
      return `missing required ${dir}\`${pred.edge_type}\` edge${target}${count}`;
    },
  },

  limits_edge: {
    label: "Limits edge",
    fields: [
      EDGE_TYPE_FIELD,
      TARGET_NODE_TYPE_FIELD,
      {
        name: "max_count",
        control: "number",
        formLabel: "Maximum count (default 1)",
        partLabel: "max count",
      },
      DIRECTION_FIELD,
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      // Ceiling check — the dual of requires_edge.
      const { matches, direction } = directedMatchingEdges(pred, ctx);
      const max = pred.max_count && pred.max_count > 0 ? pred.max_count : 1;
      if (matches.length <= max) return null;
      const dir = direction === "incoming" ? "incoming " : "";
      const target = pred.target_node_type
        ? `${direction === "incoming" ? " from" : " to"} a ${pred.target_node_type}`
        : "";
      return `carries ${matches.length} ${dir}\`${pred.edge_type}\` edges${target} (max ${max})`;
    },
  },

  forbids_edge: {
    label: "Forbids edge",
    fields: [EDGE_TYPE_FIELD, TARGET_NODE_TYPE_FIELD, WHEN_NODE_TYPE_FIELD],
    evaluate: (pred, ctx) => {
      const offender = ctx.candidateEdges.find((s) => {
        if (s.edge_type !== pred.edge_type) return false;
        if (pred.target_node_type) {
          return entityTypeFromId(s.to_id) === pred.target_node_type;
        }
        return true;
      });
      if (!offender) return null;
      const target = pred.target_node_type ? ` to a ${pred.target_node_type}` : "";
      return `carries a forbidden \`${pred.edge_type}\` edge${target}`;
    },
  },

  requires_edge_type: {
    label: "Allowed edge types",
    fields: [
      {
        name: "edge_types",
        control: "edge-type-csv",
        formLabel: "Allowed edge types (comma-separated)",
        partLabel: "edge types",
        required: true,
      },
    ],
    // Edge-type allowlist is an EDGE-scoped gate, enforced on edge creation by
    // `evaluateEdgePolicies`. It never constrains a node candidate.
    evaluate: () => null,
  },

  requires_field: {
    label: "Requires field",
    fields: [
      {
        name: "fields",
        control: "field-csv",
        formLabel: "Fields (comma-separated)",
        partLabel: "fields",
        required: true,
      },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      const missing = pred.fields.filter((f) => !isNonEmpty(ctx.candidate[f]));
      if (missing.length === 0) return null;
      return `missing required field(s): ${missing.map((m) => `\`${m}\``).join(", ")}`;
    },
  },

  forbids_field: {
    label: "Forbids field",
    fields: [
      {
        name: "fields",
        control: "field-csv",
        formLabel: "Fields (comma-separated)",
        partLabel: "fields",
        required: true,
      },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      const present = pred.fields.filter((f) => isNonEmpty(ctx.candidate[f]));
      if (present.length === 0) return null;
      return `carries forbidden field(s): ${present.map((m) => `\`${m}\``).join(", ")}`;
    },
  },

  forbids_field_pattern: {
    label: "Forbids field pattern",
    fields: [
      {
        name: "fields",
        control: "field-csv",
        formLabel: "Fields (comma-separated)",
        partLabel: "fields",
        required: true,
      },
      {
        name: "pattern",
        control: "text",
        formLabel: "Pattern (regular expression)",
        partLabel: "pattern",
        required: true,
      },
      { name: "flags", control: "text", formLabel: "Flags (optional, e.g. i)", partLabel: "flags" },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      let re: RegExp;
      try {
        re = new RegExp(pred.pattern, pred.flags ?? "i");
      } catch {
        // A malformed pattern is an authoring bug in the policy, not in the
        // candidate — fail open rather than block every write on a bad regex.
        return null;
      }
      const hit = pred.fields.find((f) => {
        const v = ctx.candidate[f];
        return typeof v === "string" && re.test(v);
      });
      if (!hit) return null;
      return `field \`${hit}\` contains forbidden pattern /${pred.pattern}/`;
    },
  },

  "flow-wiring": {
    label: "Flow wiring",
    fields: [
      EDGE_TYPE_FIELD,
      {
        name: "initial_when",
        control: "condition",
        formLabel: "Initial when",
        partLabel: "initial when",
      },
      {
        name: "terminal_when",
        control: "condition",
        formLabel: "Terminal when",
        partLabel: "terminal when",
      },
      EXEMPT_WHEN_INCOMING_FIELD,
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      // A process container (the target of ≥1 incoming `has_parent`) is a pool,
      // not a sequenced step, so it carries no `flows_to` and is excused from
      // the wiring checks below.
      if (
        pred.exempt_when_incoming_edge_type &&
        ctx.edges.some(
          (s) =>
            s.to_id === ctx.candidate.id && s.edge_type === pred.exempt_when_incoming_edge_type,
        )
      ) {
        return null;
      }
      const isInitial =
        pred.initial_when !== undefined &&
        ctx.candidate[pred.initial_when.field] === pred.initial_when.equals;
      const isTerminal =
        pred.terminal_when !== undefined &&
        ctx.candidate[pred.terminal_when.field] === pred.terminal_when.equals;
      const incoming = ctx.edges.filter(
        (s) => s.to_id === ctx.candidate.id && s.edge_type === pred.edge_type,
      );
      const outgoing = ctx.candidateEdges.filter((s) => s.edge_type === pred.edge_type);
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
      return `broken sequence flow: ${problems.join("; ")}`;
    },
  },

  unique_field: {
    label: "Unique field",
    fields: [
      { name: "field", control: "text", formLabel: "Field", partLabel: "field", required: true },
      {
        name: "case_fold",
        control: "checkbox",
        formLabel: "Case-insensitive",
        partLabel: "case-insensitive",
      },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      const candidateValue = comparableFieldValue(
        ctx.candidate[pred.field],
        Boolean(pred.case_fold),
      );
      if (candidateValue === null) return null;
      const duplicate = ctx.population.find((n) => {
        if (n.id === ctx.candidate.id || n.lifecycle === "retired") return false;
        const when = pred.when_node_type;
        if (when && when.length > 0) {
          if (!n.node_type || !when.includes(n.node_type)) return false;
        }
        return comparableFieldValue(n[pred.field], Boolean(pred.case_fold)) === candidateValue;
      });
      if (!duplicate) return null;
      const rawValue = ctx.candidate[pred.field];
      const original = typeof rawValue === "string" ? rawValue.trim() : "";
      const value = original ? ` value \`${original}\`` : "";
      return `\`${pred.field}\`${value} duplicates active ${duplicate.id}`;
    },
  },

  requires_node_type: {
    label: "Allowed node types",
    fields: [
      {
        name: "node_types",
        control: "node-type-csv",
        formLabel: "Allowed node types (comma-separated)",
        partLabel: "node types",
        required: true,
      },
    ],
    evaluate: (pred, ctx) => {
      if (isPolicyMetadataCandidate(ctx.candidate)) return null;
      const ct = ctx.candidate.node_type;
      if (ct && pred.node_types.includes(ct)) return null;
      return `node_type \`${ct ?? "<missing>"}\` not in allowlist [${pred.node_types.map((n) => `\`${n}\``).join(", ")}]`;
    },
  },

  requires_entity_type: {
    label: "Allowed entity types",
    fields: [
      {
        name: "entity_types",
        control: "entity-type-csv",
        formLabel: "Allowed entity types (comma-separated)",
        partLabel: "entity types",
        required: true,
      },
    ],
    evaluate: (pred, ctx) => {
      if (isPolicyMetadataCandidate(ctx.candidate)) return null;
      const fromId = entityTypeFromId(ctx.candidate.id);
      if (fromId && (pred.entity_types as readonly string[]).includes(fromId)) return null;
      return `entity_type \`${fromId || "<unknown>"}\` not in allowlist [${pred.entity_types.map((e) => `\`${e}\``).join(", ")}]`;
    },
  },

  requires_field_resolves_to_principal: {
    label: "Field resolves to Principal",
    fields: [
      { name: "field", control: "text", formLabel: "Field", partLabel: "field", required: true },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      const value = ctx.candidate[pred.field];
      if (typeof value !== "string" || value.length === 0) {
        return `\`${pred.field}\` is empty — expected a Principal id`;
      }
      if (!ctx.principals.has(value)) {
        return `\`${pred.field}\` = \`${value}\` does not resolve to a known Principal`;
      }
      return null;
    },
  },

  "graph-completeness": {
    label: "Graph completeness",
    fields: [
      {
        name: "list_field",
        control: "text",
        formLabel: "List field",
        partLabel: "list field",
        required: true,
      },
      EDGE_TYPE_FIELD,
      {
        name: "incoming_node_type",
        control: "node-type",
        formLabel: "Incoming node type",
        partLabel: "incoming node",
        required: true,
      },
      {
        name: "incoming_field_must_match",
        control: "text",
        formLabel: "Incoming field must match",
        partLabel: "must match",
        required: true,
      },
      WHEN_NODE_TYPE_FIELD,
    ],
    evaluate: (pred, ctx) => {
      const list = ctx.candidate[pred.list_field];
      if (!Array.isArray(list) || list.length === 0) return null;
      const missing: string[] = [];
      for (const id of list) {
        if (typeof id !== "string") continue;
        // Find an incoming node of the required type whose
        // `incoming_field_must_match` equals this id AND that has a matching
        // edge_type pointing at the candidate.
        const covered = ctx.population.some((n) => {
          if (n.node_type !== pred.incoming_node_type) return false;
          if (n[pred.incoming_field_must_match] !== id) return false;
          return ctx.edges.some(
            (s) =>
              s.from_id === n.id && s.to_id === ctx.candidate.id && s.edge_type === pred.edge_type,
          );
        });
        if (!covered) missing.push(id);
      }
      if (missing.length === 0) return null;
      return `\`${pred.list_field}\` entries lack a matching incoming \`${pred.edge_type}\` from a \`${pred.incoming_node_type}\`: ${missing.map((m) => `\`${m}\``).join(", ")}`;
    },
  },
};

/**
 * The deterministic check selectors, derived from the registry — every menu,
 * doc, and validator reads this instead of keeping its own copy.
 */
export const DETERMINISTIC_SUB_KINDS = Object.keys(DETERMINISTIC_CHECKS) as DeterministicSubKind[];

// Stored policy `data` is jsonb that can predate the current registry, arrive
// from a BPMN import, or be hand-edited — so a policy's `sub_kind` can be a
// value the registry no longer knows. The lookups below stay TOTAL for that
// case (like `checkFieldsValidationErrors`, which already guards): a check that
// indexed the registry blindly threw `undefined is not an object (evaluating
// 'w[e].fields')` and crashed the whole policies page, hiding every other
// policy and leaving no way to even open and retire the offending one.

/** The field schema for a check — `[]` for a sub_kind the registry doesn't know. */
export function checkFields(sub_kind: DeterministicSubKind): FieldSpec[] {
  return DETERMINISTIC_CHECKS[sub_kind]?.fields ?? [];
}

/** The human headline for a check — the raw sub_kind when the registry doesn't know it. */
export function checkLabel(sub_kind: DeterministicSubKind): string {
  return DETERMINISTIC_CHECKS[sub_kind]?.label ?? sub_kind;
}

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

/**
 * Validate a deterministic predicate against its field schema: required fields
 * must be present, and any edge-type reference must name a first-class edge
 * type. Returns one message per problem (empty when valid). Because it walks
 * the schema, an edge-type field can never slip past validation — closing the
 * historical gap where `flow-wiring`'s edge_type went unchecked.
 */
export function checkFieldsValidationErrors(predicate: DeterministicPredicate): string[] {
  const spec = DETERMINISTIC_CHECKS[predicate.sub_kind];
  if (!spec) return [`unknown deterministic check \`${predicate.sub_kind}\``];
  const errors: string[] = [];
  const p = predicate as Record<string, unknown>;
  for (const field of spec.fields) {
    const value = p[field.name];
    const present = isFieldPresent(field, value);
    if (field.required && !present) {
      errors.push(`predicate.${field.name} is required for \`${predicate.sub_kind}\`.`);
      continue;
    }
    if (!present) continue;
    if (field.control === "edge-type" && !EDGE_TYPE_SET.has(value as string)) {
      errors.push(
        `predicate.${field.name} \`${value}\` is not a first-class edge type. Valid edge types: ${EDGE_TYPES.join(", ")}.`,
      );
    }
  }
  return errors;
}

function isFieldPresent(field: FieldSpec, value: unknown): boolean {
  if (field.control === "condition") return Boolean(value && typeof value === "object");
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  return typeof value === "string" ? value.length > 0 : value != null;
}
