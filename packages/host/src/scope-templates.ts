/**
 * Default scope templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships three curated scopes: `global` (always installed
 * when a Doco is created), `user-flows` (opt-in at create time), and
 * `state-machines` (opt-in via `doco install-template state-machines`).
 * Per the successor to decision_01KRFG5BAJ1ATHX0QE0HHX0QEV (which
 * trimmed thirteen templates down to two) — every other
 * previously-shipped template stays project-owner-authored.
 *
 * Each template ships:
 * - `intentSummary` — the stakeholder outcome the scope serves. Becomes
 *   a real Intent entity at install time.
 * - `rules` — atomic Rule entities tagged with the scope. A Rule with a
 *   `predicate` becomes an authoring rule the engine evaluates; the
 *   seeder writes the Rule's id into the scope's `gated_by` so the
 *   citation drives evaluation, not a flag on the Rule itself (per v7).
 *
 * v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) drops the
 * `kind: "authoring"` value from RuleKind. Templates no longer mark
 * rules "authoring" explicitly — any rule with a `predicate` is
 * automatically wired into the scope's `gated_by` at seed time. Use
 * `kind: "guidance"` for prose-only directives; leave `kind` unset (or
 * use "tagged") for rules with predicates.
 */
import type { AuthoringPredicate, Lifecycle } from "@doco/shared";

export interface TemplateRule {
  /**
   * Rule kind on the seeded Rule entity. Optional — defaults to
   * "tagged" when `predicate` is set, "guidance" otherwise. v7 dropped
   * "authoring" (decision_01KRRR5BQ16ASY8HQEE0V499YG).
   */
  kind?: "guidance" | "tagged";
  /** Human-authored prose. For rules with a predicate this is the reason
   * text accompanying the structured check. For guidance rules this IS
   * the rule. */
  summary: string;
  /**
   * Engine-readable predicate. When set, the seeder adds this Rule's id
   * to the scope's `gated_by` so the citation makes it an authoring
   * rule for that scope (v7).
   */
  predicate?: AuthoringPredicate;
  /**
   * v7: when set, the engine only fires this Rule against candidates
   * whose `lifecycle` is in the list. Used by completeness rules that
   * skip drafted nodes during mid-construction.
   */
  fires_when_node_lifecycle?: Lifecycle[];
  /**
   * Optional markdown body. Renders alongside the summary on the Rule's
   * detail page.
   */
  body_md?: string;
}

export interface ScopeTemplate {
  name: string;
  /** Short readable label for the picker UI. */
  label: string;
  /** Recommended single-emoji icon. */
  icon: string;
  /** Stakeholder outcome the scope serves. Seeded as a real Intent
   * entity at install time. */
  intentSummary: string;
  /** Atomic rules seeded at install time. */
  rules: TemplateRule[];
  /**
   * v7: when set, captures into this scope (or descendants) default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The state-machines template uses
   * `"drafted"` so authors can sketch incomplete machines without
   * tripping completeness rules.
   */
  default_node_lifecycle?: Lifecycle;
}

export const DEFAULT_SCOPE_TEMPLATES: ScopeTemplate[] = [
  {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded
    // scope renamed from "constitution" → "global". The label keeps
    // "Constitution" as the readable handle next to "global" on the
    // scope list ("the doco's constitution"); the canonical name is
    // global so it sorts predictably.
    name: "global",
    label: "Global (the doco's constitution)",
    icon: "🌐",
    intentSummary:
      "The load-bearing claims that govern this Doco — invariants, authority, and the rules that other rules cite.",
    rules: [
      {
        summary:
          "Only Rule nodes may belong to the Global scope. Decisions, Intents, Actions, Reasoning, Evals, References, and Ideas tagged with Global must be re-scoped to the project-specific scope they govern; Global is reserved for the rules that govern the Doco.",
        predicate: { kind: "requires_node_type", node_types: ["rule"] },
      },
      {
        // D3 (decision_01KRRD6QM7NN2EV56NZK96DNKY): a Decision is a
        // recorded choice WITH rejected alternatives. Doco-wide.
        summary:
          "Every Decision must populate `alternatives`. A Decision is the recorded choice plus the options that were rejected and why — empty alternatives means the choice isn't documented, only the outcome.",
        predicate: {
          kind: "requires_field",
          fields: ["alternatives"],
          when_node_type: ["decision"],
        },
      },
      {
        kind: "guidance",
        summary:
          'Rules that other Rules or Decisions cite belong in the Global scope. Examples: "every public endpoint must enforce auth", "ULIDs are the canonical id".',
      },
      {
        kind: "guidance",
        summary:
          "Every Global-scoped Rule traces back to a stakeholder intent through the decisions, actions, or rules that reference it.",
      },
      {
        kind: "guidance",
        summary:
          "Implementation details, one-off bug fixes, and speculative ideas do NOT belong in the Global scope — those live in their own subject-area scopes.",
      },
      {
        kind: "guidance",
        summary:
          "Agents proactively surface this Doco's scope manifest to the project owner — naming each scope, its purpose, and which carry the `watched` flag — and remind them that watched scopes only stay load-bearing when the project owner reviews them as the project evolves: abandoning stale ones, sharpening vague ones, and adding new ones whose absence would let real work slip out of view.",
      },
    ],
  },
  {
    // Per decision_01KRRD6QM7NN2EV56NZK96DNKY the user-flows template
    // collapses from six guidance rules to two deterministic authoring
    // rules + a concise intentSummary for picker/manifest surfaces.
    name: "user-flows",
    label: "User flows",
    icon: "🌊",
    intentSummary:
      "Document end-to-end user journeys as ordered steps, branches, and decisions.",
    rules: [
      {
        summary:
          "Only Intent, Action, Decision, and Reference nodes belong to user-flows. Rules, Evals, Ideas, and Logs each have their own home — Rules govern (Global scope), Evals test (test-evals or similar), Ideas are speculative until promoted, and Logs capture recorded events rather than designed steps.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["intent", "action", "decision", "reference"],
        },
      },
      {
        summary:
          "Every Action in user-flows must reference the journey Intent it advances (a `serves` edge to an Intent). Without it the flow renderer can't group steps into a coherent journey.",
        predicate: {
          kind: "requires_edge",
          edge_type: "serves",
          target_node_type: "intent",
          when_node_type: ["action"],
        },
      },
    ],
  },
  {
    // Per decision_01KRRR5BQ16ASY8HQEE0V499YG (v7): formal state-machine
    // modeling. The template is pure data — 18 atomic Rules attached
    // to the parent scope via gated_by (auto-wired by the seeder).
    // Framework primitives the rules use: State node + triggered_by /
    // gated_by edges + drafted lifecycle + scope-level
    // default_node_lifecycle + scope inheritance with excluded_rules.
    // Project owners rename the parent scope freely — the framework
    // treats every scope through the same generic interface (Global
    // rules rule_01KRRPY12JEVQABNNRJ96YB91J,
    // rule_01KRRPZTKDXT0RREZB37VPX2AG).
    name: "state-machines",
    label: "State machines",
    icon: "🔁",
    intentSummary:
      "Model entities whose meaningful behavior is a sequence of named States and the Actions that transition between them — order lifecycles, machine workers, agent loops, anything where 'what state is it in?' matters.",
    default_node_lifecycle: "drafted",
    rules: [
      // ── Always-on deterministic (fire on any node lifecycle) ──
      {
        // D1
        summary:
          "Only State, Action, Decision, Eval, and Reference nodes belong to a state-machines scope. Other captures (Rule, Intent, Idea, Log) live elsewhere.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["state", "action", "decision", "eval", "reference"],
        },
      },
      {
        // D2
        summary:
          "`follows` edges in this scope alternate State ↔ Action — a transition Action follows a State, and a State follows the Action that produced it. Direct State → State or Action → Action `follows` edges break the wiring.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "alternates-between",
          node_types: ["state", "action"],
        },
      },
      {
        // D4
        summary:
          "State `summary` is unique within the capturing scope — duplicate State names ambiguate transitions and break referential semantics.",
        predicate: {
          kind: "unique-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          field: "summary",
        },
      },
      {
        // D7
        summary:
          "Terminal States have no outgoing `follows` transitions — terminal means terminal.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "terminal" },
          direction: "out",
          max: 0,
        },
      },
      {
        // D9 + D10 collapse into one references-resolve-in-scope check
        // over the `follows` edge: every follows target must be a node
        // in the same scope. Catches typos that target nodes outside
        // the machine.
        summary:
          "A `follows` edge must point at a node in the same scope — a State / Action that has slipped out of scope (or a typo'd id) breaks the chain.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "references-resolve-in-scope",
          edge_type: "follows",
        },
      },
      // ── Active-only deterministic ──
      // These fire only on active captures and ignore drafted neighbors.
      // The lifecycle filter inside `where` is what lets the engine
      // count "active initial states" rather than "any initial state."
      {
        // D5
        summary:
          "An active state-machine scope must have ≥1 active State of kind `initial` — every machine starts somewhere.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "count-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          where: { kind: "initial", lifecycle: ["active"] },
          comparator: ">=",
          n: 1,
        },
      },
      {
        // D6
        summary:
          "An active state-machine scope must have ≥1 active State of kind `terminal`. Perpetual machines (worker loops, services) skip this Rule on their specific scope via `excluded_rules`.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "count-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          where: { kind: "terminal", lifecycle: ["active"] },
          comparator: ">=",
          n: 1,
        },
      },
      {
        // D8
        summary:
          "Each active initial State has ≥1 outgoing `follows` to an active Action — otherwise the machine starts but never moves.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "initial", lifecycle: ["active"] },
          direction: "out",
          min: 1,
        },
      },
      {
        // D13
        summary:
          "Each active intermediate State is the `follows` target of ≥1 active Action — orphan intermediates (typos, dangling refactors) are caught at activate time.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "intermediate", lifecycle: ["active"] },
          direction: "in",
          min: 1,
        },
      },
      // ── Probabilistic ──
      {
        // P1
        summary:
          "State `summary` reads as a noun or past-participle, not an imperative verb. Acceptable: `paid`, `cart`, `cancelled`. Not: `Pay`, `Cancel`, `Process the order`.",
        predicate: {
          kind: "probabilistic",
          spec: "State `summary` reads as a noun or past-participle, not an imperative verb.",
        },
      },
      {
        // P2
        summary:
          "An Action that transitions between States names the event or command, not the destination state. Acceptable: `checkout submitted`, `payment captured`. Not: `becomes paid`.",
        predicate: {
          kind: "probabilistic",
          spec: "An Action transitioning between States names the event or command, not the destination state.",
        },
      },
      {
        // P3
        summary:
          "State `invariants` are observable predicates a reader can check — `order.payment.captured = false`, not `the order is happy`.",
        predicate: {
          kind: "probabilistic",
          spec: "State `invariants` are observable predicates, not subjective qualities.",
        },
      },
      {
        // P4
        summary:
          "The state-machine scope's purpose Intent names the entity being modeled (e.g., `order`, `worker job`, `agent session`) so readers can read the machine.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          spec: "The scope's purpose Intent names the entity being modeled.",
        },
      },
      {
        // P5
        summary:
          "Compensating or cancellation transitions reference a Decision explaining why the path exists — they're the exceptional flow and need their reasoning recorded.",
        predicate: {
          kind: "probabilistic",
          spec: "Compensating or cancellation transition Actions reference a Decision via `decision_ids` explaining why the path exists.",
        },
      },
      {
        // P-regions
        summary:
          "If a machine has multiple active States of kind `initial`, the scope's purpose Intent explains why — parallel regions, optional entry points, etc. — so readers don't assume it's a wiring mistake.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          spec: "When the scope has multiple active initial States, the scope's purpose Intent explains parallel regions or optional entry points.",
        },
      },
      {
        // P-orphan-transition
        summary:
          "A transition Action with empty `triggered_by` AND empty `gated_by` is either an explicit immediate transition (the body explains why it fires unconditionally) or an authoring oversight — capture the intent.",
        predicate: {
          kind: "probabilistic",
          spec: "A transition Action with empty triggered_by AND empty gated_by either explicitly justifies its unconditional firing in the body, or is an authoring oversight to flag.",
        },
      },
      // ── Descriptive (documentation-only) ──
      {
        // D11 (descriptive, not enforced)
        summary:
          "Reachability isn't enforced at the framework level. The completeness rules above catch missing wiring on activate (orphan intermediates) — strict reachability (every State reachable from an initial) is a manual review.",
        kind: "guidance",
      },
      {
        // D12 (descriptive)
        summary:
          "Hierarchical / composite / parallel States are deliberately not modeled in v1. A machine that needs them models the sub-machine as a separate scope under this scope's parent.",
        kind: "guidance",
      },
    ],
  },
];

/** Lookup a template by name. Returns undefined for unknown names. */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === name);
}
