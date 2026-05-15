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
        kind: "guidance",
        summary:
          'Rules that other Rules or Decisions cite belong in the Global scope. Examples: "every public endpoint must enforce auth", "ULIDs are the canonical id".',
      },
      {
        kind: "guidance",
        summary:
          "Only Rule nodes belong in the Global scope. Load-bearing Decisions belong in the project-specific scope they govern and can reference Global Rules when needed.",
      },
      {
        kind: "guidance",
        summary:
          "Every Global-scoped Rule traces back to a stakeholder intent through the decisions, actions, or rules that reference it; do not tag the Intent itself with Global.",
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
    name: "user-flows",
    label: "User flows",
    icon: "🌊",
    intentSummary:
      "End-to-end user journeys are documented step-by-step so any feature can be traced from start to finish.",
    rules: [
      {
        kind: "guidance",
        summary:
          'Each flow gets one Intent representing the journey. Examples: "user buys a product", "agent claims a Doco".',
      },
      {
        kind: "guidance",
        summary:
          "Each step in the flow is an Action chained with the `follows` field so the order is explicit and the cycle-lint guards against loops.",
      },
      {
        kind: "guidance",
        summary:
          'Each branch in the flow is a Decision referenced from the Action that depends on it via `decision_ids`. Example: "if cart total > $X, require 2FA".',
      },
      {
        kind: "guidance",
        summary: "Use Reasoning entities to justify non-obvious orderings or merges in the flow.",
      },
      {
        kind: "guidance",
        summary:
          "Don't capture state diagrams in user-flows — Doco is process-centric, not state-machine-centric.",
      },
    ],
  },
];

/** Lookup a template by name. Returns undefined for unknown names. */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === name);
}
