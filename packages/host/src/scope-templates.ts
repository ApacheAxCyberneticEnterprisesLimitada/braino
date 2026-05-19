/**
 * Default scope templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships four curated scopes. Two are auto-installed on
 * every new Doco (flagged `auto_install: true`): `#global` (the
 * Constitution) and `#important` (catch-all for important Doco-wide
 * decisions that don't fit a topical scope). The other two are opt-in:
 * `#user-flows` (opt-in at create time) and `#state-machines` (opt-in
 * via `doco install-template #state-machines`). Per the successor to
 * decision_01KRFG5BAJ1ATHX0QE0HHX0QEV (which trimmed thirteen
 * templates down to two) — every other previously-shipped template
 * stays project-owner-authored. All scope names are hashtag-shaped —
 * the leading `#` is part of the canonical name on every surface.
 *
 * Each template ships:
 * - `summary` — the description text rendered under the scope name on
 *   every surface (list card, detail page, bootstrap manifest). Written
 *   directly onto the Scope row's `summary` column at install time.
 * - `rules` — atomic Rule entities tagged with the scope. A Rule with a
 *   `predicate` becomes an authoring rule the engine evaluates; the
 *   seeder writes the Rule's id into the scope's `gated_by` so the
 *   citation drives evaluation, not a flag on the Rule itself (per v7).
 * - `allowed_node_types` (optional) — a generic scope attribute that
 *   restricts which node types can be tagged into the scope. #global
 *   ships with `["rule"]` so the doco's constitution is a pure rule book;
 *   the framework rejects POSTs of any other node type whose `scopes`
 *   list names this scope.
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
  /** Description text rendered under the scope name on every surface
   * (list card, detail page, bootstrap manifest). Written directly onto
   * the Scope row's `summary` column at install time. */
  summary: string;
  /** Atomic rules seeded at install time. */
  rules: TemplateRule[];
  /**
   * Generic scope attribute that restricts which node types are accepted
   * into the scope. When set, captures of any node whose `scopes` list
   * names this scope must have a `node_type` in this allowlist; others
   * are rejected. #global ships with `["rule"]` so the constitution is a
   * pure rule book. Drives behavior without any name-based check (per
   * rule_01KRRVPBS07HDBCXY6TJ5A5TAT).
   */
  allowed_node_types?: ("decision" | "intent" | "action" | "rule" | "log" | "eval" | "reference" | "idea" | "state")[];
  /**
   * v7: when set, captures into this scope (or descendants) default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The state-machines template uses
   * `"drafted"` so authors can sketch incomplete machines without
   * tripping completeness rules.
   */
  default_node_lifecycle?: Lifecycle;
  /**
   * When true, the framework installs this scope on every new Doco
   * automatically. When false/unset, the project owner opts in (via
   * the create-time picker, the scope manager, or
   * `doco install-template <name>`). Lets the auto-install set evolve
   * without name-driven branching in the creation handler — see the
   * Global rule "Keep framework behavior independent of scope names".
   */
  auto_install?: boolean;
  /**
   * Initial `watched` value applied when this template is auto-installed.
   * Only meaningful when `auto_install` is true. The project owner can
   * flip the value any time from the scope's edit page.
   */
  auto_install_watched?: boolean;
}

export const DEFAULT_SCOPE_TEMPLATES: ScopeTemplate[] = [
  {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded
    // scope renamed from "constitution" → "global". The label keeps
    // "Constitution" as the readable handle next to "#global" on the
    // scope list ("your doco's constitution"); the canonical name is
    // `#global` so it sorts predictably and reads as a hashtag tag
    // wherever it appears.
    name: "#global",
    label: "#global (your doco's constitution)",
    icon: "🌐",
    auto_install: true,
    auto_install_watched: true,
    summary:
      "Your doco's rule book — the standing rules, invariants, and authority claims anyone can cite from anywhere. Rules only.",
    allowed_node_types: ["rule"],
    rules: [
      {
        kind: "guidance",
        summary:
          "Add each node to the most specific applicable scope. Don't create a new scope to fit a node. If you're an agent, propose it to your client and wait for their confirmation first.",
      },
      {
        kind: "guidance",
        summary:
          "If you're an agent, check with your client before adding a new rule to the global scope.",
      },
      {
        kind: "guidance",
        summary:
          "AI agents: document every explicit rule and decision from the project owner, and especially every correction. Corrections are the highest-signal moments — they encode preferences that aren't visible in the code or docs. Capture them in Doco the same turn they happen, so the next agent (or the next session of you) doesn't repeat the mistake.",
      },
    ],
  },
  {
    // Catch-all scope for important Doco-wide decisions that don't
    // naturally fit a topical scope. Auto-installed alongside #global
    // on every new Doco so the project owner has a landing place for
    // cross-cutting decisions from day one — the alternative is
    // letting orphan decisions push agents toward minting new scopes
    // (which Global Rule 1 explicitly forbids without confirmation).
    name: "#important",
    label: "#important",
    icon: "⭐",
    auto_install: true,
    auto_install_watched: true,
    summary:
      "Important doco-wide decisions that don't naturally fit a more specific subject-area scope.",
    rules: [],
  },
  {
    // Per decision_01KRRD6QM7NN2EV56NZK96DNKY the #user-flows template
    // collapses from six guidance rules to deterministic authoring
    // rules + a concise summary for picker/manifest surfaces.
    name: "#user-flows",
    label: "#user-flows",
    icon: "🌊",
    summary: "Document end-to-end user journeys as ordered steps, branches, and decisions.",
    rules: [
      {
        // Membership check: probabilistic semantic gate, with a
        // deterministic node-type allowlist that excludes Rule. Rules
        // tagged into #user-flows *govern* how journeys are authored;
        // they aren't themselves journey content, so subjecting them
        // to the journey-prose check would lock out the rules that
        // define the scope's contract.
        summary:
          "A node belongs in #user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature. (Rule nodes that govern user-flow authoring are exempt — they shape the scope rather than living inside it.)",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in #user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature.",
          when_node_type: ["intent", "action", "decision", "reference"],
        },
      },
      {
        summary:
          'Action nodes in #user-flows pass the summary style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
        predicate: {
          kind: "probabilistic",
          spec: 'Action nodes in #user-flows pass the summary style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
          when_node_type: ["action"],
        },
      },
      {
        summary:
          "Only Intent, Action, Decision, Reference, and Rule nodes belong to #user-flows. Evals, Ideas, and Logs each have their own home.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["intent", "action", "decision", "reference", "rule"],
        },
      },
      {
        summary:
          "Every Intent in #user-flows must declare the principal who wants the journey in the `wanted_by` field.",
        predicate: {
          kind: "requires_field",
          fields: ["wanted_by"],
          when_node_type: ["intent"],
        },
      },
      {
        summary:
          "Every Action in #user-flows must declare the principal who performs the designed step in the `actor_id` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_node_type: ["action"],
        },
      },
      {
        summary:
          "Every Decision in #user-flows must declare the principal who owns the branch or choice in the `decided_by` field.",
        predicate: {
          kind: "requires_field",
          fields: ["decided_by"],
          when_node_type: ["decision"],
        },
      },
      {
        summary:
          "Every Action in #user-flows must reference the journey Intent it advances (a `serves` edge to an Intent). Without it the flow renderer can't group steps into a coherent journey.",
        predicate: {
          kind: "requires_edge",
          edge_type: "serves",
          target_node_type: "intent",
          when_node_type: ["action"],
        },
      },
      {
        // #user-flows v2: each principal listed on the Intent's
        // `actors` must be the actor_id of ≥1 Action serving the
        // Intent. Fires only when the Intent moves to `active` —
        // drafted Intents can be captured first and have their Actions
        // filled in after.
        summary:
          "Every principal listed in an Intent's `actors` must be the `actor_id` of at least one Action that `serves` the Intent. Fires when the Intent is active — drafted Intents are allowed to be incomplete.",
        predicate: {
          kind: "graph-completeness",
          scope_ref: "$capture_scope",
          list_field: "actors",
          edge_type: "serves",
          incoming_node_type: "action",
          incoming_field_must_match: "actor_id",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["active"],
      },
      {
        // user-flows v2: actor_id must point at a real Principal of
        // type human or agent — rejects "the browser", "app.js",
        // "the system" as actors. System-internal steps belong in
        // `apis` or `adrs`, not in a user-flow.
        summary:
          "An Action's `actor_id` must resolve to an existing Principal whose type is `human` or `agent`. System-internal steps (the browser, a background job, a script) belong in `apis` or `adrs`, not in a user-flow.",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          allowed_principal_types: ["human", "agent"],
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
    name: "#state-machines",
    label: "#state-machines",
    icon: "🔁",
    summary:
      "Track anything that moves through stages — orders, tasks, bug tickets, deploys. Each stage is a State; transitions are Actions.",
    default_node_lifecycle: "drafted",
    rules: [
      // ── Always-on deterministic (fire on any node lifecycle) ──
      {
        // D1 — the seeder tags the scope's seed Intent + Rules into this
        // scope too, so they have to be allowed. Idea and Log have their
        // own homes elsewhere.
        summary:
          "Only State, Action, Decision, Eval, Reference, Intent, and Rule nodes belong to a #state-machines scope. Other captures (Idea, Log) live elsewhere — Ideas are speculative until promoted; Logs capture recorded events rather than designed steps.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["state", "action", "decision", "eval", "reference", "intent", "rule"],
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
        // D7 — semantic: a terminal State has no successor Action. An
        // Action that fires AFTER a terminal State would carry
        // `follows: [<that-terminal-state>]`, materializing as an
        // incoming `follows` edge on the terminal State. Direction
        // `in` is the correct check (the prior `out` reading flipped
        // it and would have rejected properly-wired terminal States
        // that themselves follow their predecessor Action).
        summary:
          "Terminal States have no successor Action — no Action's `follows` may point at a terminal State.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "terminal" },
          direction: "in",
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
          "An active #state-machines scope must have ≥1 active State of kind `initial` — every machine starts somewhere.",
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
          "An active #state-machines scope must have ≥1 active State of kind `terminal`. Perpetual machines (worker loops, services) skip this Rule on their specific scope via `excluded_rules`.",
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
        // D8 — same direction semantics as D7. "Initial State has a
        // successor Action" = at least one Action's `follows`
        // includes this State, which is an INCOMING follows edge on
        // the State. The prior `out` reading would have rejected
        // properly-wired initial States.
        summary:
          "Each active initial State has ≥1 successor Action — otherwise the machine starts but never moves.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "initial", lifecycle: ["active"] },
          direction: "in",
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
      // v7: each rule is gated to the node type it actually inspects so
      // the LLM judge isn't asked to evaluate, e.g., a State's summary
      // against a spec about compensating Actions.
      {
        // P1
        summary:
          "State `summary` reads as a noun or past-participle, not an imperative verb. Acceptable: `paid`, `cart`, `cancelled`. Not: `Pay`, `Cancel`, `Process the order`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `summary` field. It must read as a noun or past-participle naming the position the modeled entity occupies (`cart`, `paid`, `cancelled`, `awaiting-review`). It must NOT be an imperative verb naming an action (`Pay`, `Cancel`, `Process the order`). A single-word past-participle adjective is acceptable.",
        },
      },
      {
        // P2
        summary:
          "An Action that transitions between States names the event or command, not the destination state. Acceptable: `checkout submitted`, `payment captured`. Not: `becomes paid`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "An Action transitioning between States names the event or command, not the destination state.",
        },
      },
      {
        // P3
        summary:
          "State `invariants` are observable predicates a reader can check — `order.payment.captured = false`, not `the order is happy`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `invariants` array. If `invariants` is empty, missing, or absent from the entity, this rule PASSES (vacuously true). When invariants are present, each entry must read as an observable predicate a reader can check programmatically (e.g., `order.payment.captured = false`), not a subjective quality (e.g., `the order is happy`). Do NOT judge the State's `summary` or `body_md` — only the invariants array matters here.",
        },
      },
      {
        // P4
        summary:
          "The #state-machines scope's purpose Intent names the entity being modeled (e.g., `order`, `worker job`, `agent session`) so readers can read the machine.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          when_node_type: ["intent"],
          spec: "The scope's purpose Intent names the entity being modeled.",
        },
      },
      {
        // P5 — fires only on Actions that look like compensating /
        // cancellation paths. Happy-path transitions pass.
        summary:
          "Compensating or cancellation transitions reference a Decision explaining why the path exists — they're the exceptional flow and need their reasoning recorded. Happy-path transitions are exempt.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action represents a compensating, cancellation, rollback, refund, undo, abort, abandon, or otherwise-undoing transition between States. Look at the Action's `verb` and `summary` for words like 'cancel', 'refund', 'rollback', 'undo', 'revert', 'abort', 'abandon', 'compensate', 'reverse'. If the Action is a normal happy-path transition (e.g., 'checkout submitted', 'payment captured', 'order shipped'), this rule PASSES — return ok. STEP 2 — only if the Action IS a compensating/cancellation transition, check that `decision_ids` is non-empty. If empty, FAIL with a reason explaining the Action looks like a compensating path but doesn't cite a Decision.",
        },
      },
      {
        // P-regions
        summary:
          "If a machine has multiple active States of kind `initial`, the scope's purpose Intent explains why — parallel regions, optional entry points, etc. — so readers don't assume it's a wiring mistake.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          when_node_type: ["intent"],
          spec: "When the scope has multiple active initial States, the scope's purpose Intent explains parallel regions or optional entry points.",
        },
      },
      {
        // P-orphan-transition
        summary:
          "A transition Action with empty `triggered_by` AND empty `gated_by` is either an explicit immediate transition (the body explains why it fires unconditionally) or an authoring oversight — capture the intent.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
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

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored with their canonical hashtag-shaped names
 * (`#global`, `#user-flows`, `#state-machines`). For back-compat, the
 * lookup also accepts the bare form (`global`, `user-flows`,
 * `state-machines`) — older clients that POST `template_name: "global"`
 * continue to work.
 */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  const canonical = name.startsWith("#") ? name : `#${name}`;
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === canonical);
}
