/**
 * Default scope templates (ADR-082).
 *
 * The framework ships two curated scopes: `global` (always installed when
 * a Doco is created) and `user-flows` (opt-in at create time or via the
 * scope picker). Per the successor to decision_01KRFG5BAJ1ATHX0QE0HHX0QEV
 * we trimmed the registry from thirteen templates down to these two —
 * every previously-shipped template (`adrs`, `apis`, `bugs`, `runbooks`,
 * `post-mortems`, `glossary`, `roadmap`, `design-language`, `framework`,
 * `coding-style`, `test-evals`) is now project-owner-authored. The
 * framework no longer prescribes those scopes; a project that wants one
 * creates it custom (or copies the prose from elsewhere).
 *
 * Each template ships:
 * - `intentSummary` — the stakeholder outcome the scope serves. Becomes
 *   a real Intent entity in the Doco at install time (Doco creation for
 *   `global`; scope-picker click for `user-flows` and any future
 *   templates). The Intent owns its body once seeded; the project owner
 *   can edit, deprecate, or supersede it like any other Intent.
 * - `rules` — atomic guidance + authoring rules. Each entry becomes its
 *   own Rule entity tagged in_scope_of the new scope. "Atomic" matters:
 *   one prose blob splits into multiple Rule nodes (one per directive)
 *   so the project owner can deprecate, sharpen, or supersede each
 *   directive independently. No more single-blob seed.
 *
 * What the framework no longer ships:
 * - `purpose` — replaced by `intentSummary` (a real Intent, not a string
 *   on the scope).
 * - `guidelines` — replaced by `rules[]` (real Rule entities, not a
 *   single prose blob seeded as one guidance Rule).
 *
 * Add to this list sparingly. Every default rule the framework seeds is
 * one more thing every Doco starts with — and "deprecatable" doesn't
 * mean "actually deprecated." Conservative is the right default.
 */
import type { AuthoringPredicate } from "@doco/shared";

export interface TemplateRule {
  kind: "authoring" | "guidance";
  /** Human-authored prose. For guidance rules this IS the rule; for
   * authoring rules this is the reason text accompanying the structured
   * predicate. */
  summary: string;
  /** Required when `kind === "authoring"`. The engine evaluates this at
   * write time. Omitted for guidance rules. */
  predicate?: AuthoringPredicate;
}

export interface ScopeTemplate {
  name: string;
  /** Short readable label for the picker UI. */
  label: string;
  /** Recommended single-emoji icon. Surfaces in the /scopes list, the
   * Global scope page, and the footer lines of captures into this
   * scope. Owners can change it after creating the scope. */
  icon: string;
  /** Stakeholder outcome the scope serves. Seeded as a real Intent
   * entity at install time. Also rendered as the picker description so
   * the project owner knows what the scope is for. */
  intentSummary: string;
  /** Atomic rules seeded at install time. One Rule entity per entry. */
  rules: TemplateRule[];
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
        kind: "authoring",
        summary:
          "Only Rule nodes may belong to the Global scope. Decisions, Intents, Actions, Reasoning, Evals, References, and Ideas tagged with Global must be re-scoped to the project-specific scope they govern; Global is reserved for the rules that govern the Doco.",
        predicate: { kind: "requires_node_type", node_types: ["rule"] },
      },
      {
        // D3 (decision_01KRRD6QM7NN2EV56NZK96DNKY): a Decision is a
        // recorded choice WITH rejected alternatives. Doco-wide.
        kind: "authoring",
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
    // rules + a concise intentSummary for picker/manifest surfaces. The
    // previous guidance is made structural via D1 / D2.
    name: "user-flows",
    label: "User flows",
    icon: "🌊",
    intentSummary:
      "Document end-to-end user journeys as ordered steps, branches, and decisions.",
    rules: [
      {
        // D1: restrict the scope to flow-relevant types. Rules and Evals
        // don't model sequence; Ideas are speculative and should be
        // promoted to an Action/Decision before joining a flow; Logs are
        // recorded happenings (handled in a separate scope per ADR).
        // `reasoning` is listed in the agent-reference's 12-type
        // walkthrough but absent from the NODE_TYPES union today; if it
        // gets formalized, extend this list.
        kind: "authoring",
        summary:
          "Only Intent, Action, Decision, and Reference nodes belong to user-flows. Rules, Evals, Ideas, and Logs each have their own home — Rules govern (Global scope), Evals test (test-evals or similar), Ideas are speculative until promoted, and Logs capture recorded events rather than designed steps.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["intent", "action", "decision", "reference"],
        },
      },
      {
        // D2: every Action in user-flows links the journey Intent it
        // advances. Uses the canonical Action→Intent edge `serves`.
        // when_node_type ensures the rule fires only for Actions — the
        // Intent itself isn't asked to serve itself.
        kind: "authoring",
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
];

/** Lookup a template by name. Returns undefined for unknown names. */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === name);
}
