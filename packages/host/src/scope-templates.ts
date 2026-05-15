/**
 * Default scope templates (ADR-082).
 *
 * Curated set of scopes most projects benefit from. Each carries a `purpose`
 * (why this scope exists) and `guidelines` (how to author nodes inside it).
 * Both are exposed to agents during Doco onboarding so they author nodes
 * the way the owner + the framework expect.
 *
 * Add to this list sparingly — it's the default surface area users see when
 * creating a Doco. Specialised scopes (e.g. `country/*`, `pii`) should stay
 * project-specific, not promoted to defaults.
 */
export interface ScopeTemplate {
  name: string;
  /** Short readable label for the picker UI. */
  label: string;
  /** Recommended single-emoji icon. Surfaces in the /scopes list, the
   * /constitution tab, and the footer lines of captures into this
   * scope. Owners can change it after creating the scope. */
  icon: string;
  purpose: string;
  guidelines: string;
}

export const DEFAULT_SCOPE_TEMPLATES: ScopeTemplate[] = [
  {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded
    // scope renamed from "constitution" → "global". The label keeps
    // "Constitution" as the readable handle next to "global" on the
    // scope list ("the doco's constitution"); the canonical name is
    // global so it sorts predictably and isn't conflated with the
    // /constitution route (which was removed).
    name: "global",
    label: "Global (the doco's constitution)",
    icon: "🌐",
    purpose:
      "The load-bearing claims that govern this Doco — invariants, authority, and the rules that other rules cite. Every Doco has one.",
    guidelines: `The Global scope is where you put the rules that other rules cite — the doco's constitution. It's not a list of "nice-to-haves" — it's the schema-shaped commitments the project is held to.

What belongs here:
- **Rules** that govern the Doco as a whole or that other Rules / Decisions reference. ("Every public endpoint must enforce auth", "ULIDs are the canonical id".)

What does NOT belong:
- Decisions, Intents, Actions, Reasoning, References, Ideas, or Evals. Global membership is reserved for Rule nodes only.
- Implementation details (those live in scope_userflow / scope_design_language / scope_coding_style).
- One-off bug fixes (scope_bugfix).
- Speculative ideas (scope_meta).

The Global scope has its own authoring rules, and every one of them runs for every new node in this Doco, even when the node is not tagged Global:
- **mandatory_scope** — declare scopes that every node in this Doco must list.
- **requires_*/forbids_* and probabilistic rules** — declare Doco-wide structure and prose checks.

If you need a new invariant, capture it as a Rule in this scope. If the invariant comes from an ADR-level Decision, put that Decision in the project-specific scope it governs and reference the Global Rule from there.`,
  },
  {
    name: "test-evals",
    label: "Test evals",
    icon: "🧪",
    purpose:
      "Named, executable tests + LLM evals that pin the meaning of load-bearing claims. Inspired by TDD unit tests + the AI eval pattern.",
    guidelines: `Every load-bearing claim in the Doco should have at least one **Eval** here that re-executes the claim's intent and proves it still holds. The Eval is the unit test of the documentation.

Run history is NOT captured in the Doco. The runner updates each Eval's \`last_run_at\` + \`last_status\` + \`last_reason\` in place. Per-run records live in CI logs or whatever eval tool you point at this scope; if you need a Doco-side audit trail, write a Reference node pointing at the run log.

Eval frontmatter:
- \`name\` — short identifier ("rejects-reserved-slug").
- \`target_ref\` — the entity this Eval tests (a Decision, Rule, Action).
- \`criterion\` — \`{ kind: "exact" | "shape" | "llm-judge", spec?: string }\`.
- \`input\` — the test's input (any shape).
- \`expected\` — the expected output. For \`llm-judge\` this is prose ("the response should reject the slug with a useful error citing the reserved list").
- \`actual\` — last-observed output (the runner writes this).
- \`last_run_at\`, \`last_status\`, \`last_reason\` — latest-run metadata (mutable; runner overwrites).

Examples that fit this scope:
- An Eval for ADR-120 reserved slugs: input \`{ slug: "settings" }\` to POST /api/decisions.json → expect 400 with the reserved-list error.
- An LLM-judge Eval for a Design Language requirement: input "render Button with variant=destructive" → judge whether the response describes a red button.`,
  },
  {
    name: "user-flows",
    label: "User flows",
    icon: "🌊",
    purpose:
      "End-to-end user journeys: how a person (or external system) moves through a feature from start to finish.",
    guidelines: `Treat each flow as a sequence. Use BPMN-style decomposition:

- One **Intent** per flow ("user buys a product", "agent claims a Doco").
- One or more **Actions** per step the user/system performs. Chain them with the \`follows\` field so the order is explicit and the cycle-lint guards against loops.
- One **Decision** per branch ("if cart total > $X, require 2FA"). Reference the Decision from the Action that depends on it via \`decision_ids\`.
- Use **Reasoning** to justify non-obvious orderings or merges.

Don't try to capture state diagrams here — Doco is process-centric, not state-machine-centric.`,
  },
  {
    name: "adrs",
    label: "Architecture decisions (ADRs)",
    icon: "🏗️",
    purpose:
      "Architecture Decision Records: durable rationale for choices about structure, technology, and tradeoffs.",
    guidelines: `One **Decision** per choice. Required fields: \`question\`, \`chosen\`, \`alternatives\`. Recommended sections:

- **Context** — what forces are in play
- **Options considered** — list every alternative weighed
- **Choice** — what was decided
- **Consequences** — what becomes easier/harder

Number ADRs sequentially using the \`number\` field ("ADR-042"). Use \`supersedes\`/\`superseded_by\` when a new ADR replaces an old one.`,
  },
  {
    name: "apis",
    label: "API contracts",
    icon: "🔌",
    purpose:
      "External API contracts: the surface other systems depend on. Source of truth for endpoints, payloads, and breaking-change history.",
    guidelines: `One **Decision** per endpoint or per significant contract change. Capture:

- HTTP method, path, auth requirements
- Request schema (params, body)
- Response schema (success + error shapes)
- At least one example request + response
- Versioning + abandonment timeline

When a contract changes incompatibly, write a new Decision and link it via \`supersedes\` to the old one. Reference the implementation **Action** that shipped the change.`,
  },
  {
    name: "bugs",
    label: "Bugs",
    icon: "🐞",
    purpose:
      "Reported defects and their fixes. The bridge between symptoms users see and the rationale behind the fix.",
    guidelines: `Each bug:

1. **Action** capturing the report — \`verb: report_bug\`, severity, repro steps, link to source (ticket / chat / commit).
2. **Decision** capturing the fix — what was wrong, why the fix is correct, regression-test added.
3. The fix Action references the bug Action via \`decision_ids\` and the Decision; chain via \`follows\` if the fix depends on prior decisions.

Set \`scope_bugfix\` (or this scope) on both. Optionally tag a \`scope_regression_guard\` if a test was added.`,
  },
  {
    name: "runbooks",
    label: "Runbooks",
    icon: "📖",
    purpose:
      "Operational procedures: 'when X happens, do Y.' Read by people + agents on call.",
    guidelines: `One **Intent** per scenario ("recover from primary DB failover"). Each step is an **Action** chained with \`follows\` so the order is unambiguous.

For every step that has a non-trivial rollback, link a sibling Action with \`verb: rollback_*\` so the recovery path is also captured. Cross-reference monitoring + alert sources via **Reference** entities.`,
  },
  {
    name: "post-mortems",
    label: "Post-mortems",
    icon: "🪦",
    purpose:
      "Incident analyses: what happened, why, and what changes prevent recurrence.",
    guidelines: `One **Intent** per incident. Sections:

1. **Timeline** — chained Actions describing what happened, by whom, and when (\`follows\` orders them).
2. **Impact** — captured on the Intent's \`outputs\`.
3. **Root cause** — a **Reasoning** entity tying the incident to its underlying cause.
4. **Prevention** — one or more **Decisions** recording the changes adopted to prevent recurrence. Each Prevention Decision should link to the incident Intent via \`intent_ids\`.

Avoid blame; focus on the system. The post-mortem is a learning artifact, not a record of fault.`,
  },
  {
    name: "glossary",
    label: "Glossary",
    icon: "📔",
    purpose:
      "Domain terminology: the canonical definitions of project-specific terms.",
    guidelines: `One **Reference** per term, with \`ref_type: document\` and \`locator\` pointing at the canonical source (or set to "internal" if the term is project-coined).

Each term's Reference should include in \`summary\` a 1-2 sentence definition. Use \`scopes\` to attach related terms to the same domain (e.g., \`scopes: [glossary, payments]\` for a payment-specific term).

When a term is renamed or abandoned, write a new Reference and link to the old via \`supersedes\`.`,
  },
  {
    name: "roadmap",
    label: "Roadmap",
    icon: "🗺️",
    purpose:
      "Planned work: commitments and intentions about what will be built next.",
    guidelines: `An **Intent** for each planned outcome. Order intents with \`follows\` to express sequence.

When the team commits to a date, capture a **Decision** ("ship X by 2026-Q3") referencing the Intent. When the work starts, write an **Action** chained from the commitment Decision. When done, the Action's \`outputs\` close the loop.

Roadmap items that get cut should have their lifecycle set to \`abandoned\` rather than be deleted — the trail of "what we considered + dropped" is part of the rationale.`,
  },
  {
    name: "design-language",
    label: "Design language",
    icon: "🎨",
    purpose:
      "The design vocabulary of this product — tokens, components, conventions, and concrete usage examples. Every UI Decision in the Doco should reference this scope.",
    guidelines: `Follow this three-section structure so the scope stays a usable reference and not a soup of opinions.

## Requirements

The MUST/SHOULD properties that bind every UI element. Examples:
- All text MUST be readable at 200% zoom.
- Primary actions SHOULD be reachable from any context in ≤2 clicks.
- Destructive actions MUST require two-step confirmation (per ADR-124).

Capture each as a **Rule** in this scope with \`modality: must | must_not | should | should_not\`.

## How each element is used

For each component (Button, Card, Input, Badge, Modal, …), a **Decision** with:
- **Name** + visual reference (a Reference node pointing at a screenshot or Storybook URL).
- **Contract** — what props it takes, what variants exist, what semantics each variant has.
- **When to use** — the situations where this is the right element.
- **When NOT to use** — the situations where another element is right.
- **Links to examples** — Reference nodes pointing at concrete usages in the product.

## Examples

A **Reference** for each rendered usage in the product. Each example links back to the component Decision via \`scopes: [scope_design_language]\` and (optionally) \`born_from\` pointing at the Decision.

## Rule the engine should enforce (membership)

Any Decision tagged with this scope should reference at least one element described above. The scope's \`rules\` can capture this declaratively once we author the elements.

## PATCH the governing Decision, don't open a sibling

For copy / affordance / interaction tweaks to a component already governed by a \`design-language\` Decision, **PATCH that Decision** rather than opening a sibling node. The Decision tracks the element's reasoning over its lifetime — a 2-line helper-text removal that reverses part of an earlier rollout belongs as an appended note on the original, not as a new Decision.

The one-liner: \`doco patch decision <id> --append-body "Update YYYY-MM-DD: <what changed + why>"\`. If the search hits at the top of your reply named the governing Decision at vector_score > ~0.45, that's the one to patch.`,
  },
  {
    name: "framework",
    label: "Framework",
    icon: "⚙️",
    purpose:
      "Internal framework refinements — CLI templates, hook scripts, bootstrap pipeline, canonical instructions, scope templates, and the build that propagates them. Changes here flow to every Doco that installs this framework.",
    guidelines: `Use this scope for any change to the framework itself (the code that ships *to* every Doco, not the content of any single Doco). Concrete examples:

- Edits to \`packages/api/src/instructions.ts\` (the canonical served at \`/api/v1/agent-bootstrap\`).
- Edits to the agent bootstrap hooks (\`packages/cli/templates/agent-bootstrap/.claude/\`) — SessionStart, UserPromptSubmit, PostToolUse, Stop.
- New or modified default scope templates (\`packages/host/src/scope-templates.ts\`).
- New or modified \`doco\` CLI subcommands (\`doco capture\`, \`doco patch\`, …).
- New or modified API endpoints under \`/api/*\`.

## Capture in this scope, on top of whatever else applies

\`framework\` stacks. A bug fix in the framework gets \`bugs\` + \`framework\`; a UI tweak to the framework's own admin pages gets \`design-language\` + \`framework\`. The \`framework\` tag is how a Doco's owner tells "this change ripples out" apart from "this is project-internal."

## Recommended: watched=true

When the project owner installs this template, they typically set \`watched: true\` (the soft attention signal). Framework changes are high-leverage and high-blast-radius — the watched flag nudges agents to consider tagging \`framework\` whenever they touch the relevant code, instead of silently missing it. ADR-137bis blocks a hard default, so the installer must say \`--watched true\` explicitly. Recommended phrasing in onboarding prose: *"Framework scope is high-leverage; default it watched=true so future agents notice when they're touching the propagation surface."*

## PATCH the governing Decision, don't open a sibling

The framework's own changes obey the same rule \`design-language\` calls out: when a search hit at vector_score > ~0.45 names the file or the territory you're touching, **PATCH that Decision** with \`doco patch decision <id> --append-body "..."\` rather than writing a sibling. Framework Decisions are the canonical record of how the framework's behavior evolved — fragmenting them across near-duplicates makes the trail unreadable.

## Watched-scope dual citizenship

A Decision can sit in \`framework\` + a subject scope (\`design-language\`, \`adrs\`, \`bugs\`, …) at the same time; that's the normal shape. The \`framework\` tag is rarely the *only* scope on a node.`,
  },
  {
    name: "coding-style",
    label: "Coding style",
    icon: "💻",
    purpose:
      "How code is written in this project. Naming, imports, errors, comments, file shape.",
    guidelines: `One **Rule** per coding convention. Examples:

- "Use named imports, not default imports" — \`modality: must\`, \`phase: pre\`.
- "Prefer single-quoted strings unless the string contains a quote" — \`modality: should\`.
- "Never use \`console.log\` in production code" — \`modality: must_not\`.
- "Comments explain WHY, not WHAT" — \`modality: should\`.
- "Every public function has a JSDoc comment with at least one example" — \`modality: should\`.
- "Test files mirror the source structure: \`x/y.ts\` ↔ \`x/__tests__/y.test.ts\`" — \`modality: must\`.

Group related rules by referencing a parent scope or by sharing \`born_from\` — the lint engine can then surface them as a unit. When a convention changes, write a new Rule and link to the old via \`superseded_by\` so the trail of "what we used to do" survives.`,
  },
];

/** Lookup a template by name. Returns undefined for unknown names. */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === name);
}
