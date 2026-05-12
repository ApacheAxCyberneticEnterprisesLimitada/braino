/**
 * Default scope templates (ADR-082).
 *
 * Curated set of scopes most projects benefit from. Each carries a `purpose`
 * (why this scope exists) and `guidelines` (how to author nodes inside it).
 * Both are exposed to agents during Doco onboarding so they author nodes
 * the way the human + the framework expect.
 *
 * Add to this list sparingly — it's the default surface area users see when
 * creating a Doco. Specialised scopes (e.g. `country/*`, `pii`) should stay
 * project-specific, not promoted to defaults.
 */
export interface ScopeTemplate {
  name: string;
  /** Short human-readable label for the picker UI. */
  label: string;
  purpose: string;
  guidelines: string;
}

export const DEFAULT_SCOPE_TEMPLATES: ScopeTemplate[] = [
  {
    name: "user-flows",
    label: "User flows",
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
    purpose:
      "External API contracts: the surface other systems depend on. Source of truth for endpoints, payloads, and breaking-change history.",
    guidelines: `One **Decision** per endpoint or per significant contract change. Capture:

- HTTP method, path, auth requirements
- Request schema (params, body)
- Response schema (success + error shapes)
- At least one example request + response
- Versioning + deprecation timeline

When a contract changes incompatibly, write a new Decision and link it via \`supersedes\` to the old one. Reference the implementation **Action** that shipped the change.`,
  },
  {
    name: "bugs",
    label: "Bugs",
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
    purpose:
      "Operational procedures: 'when X happens, do Y.' Read by humans + agents on call.",
    guidelines: `One **Intent** per scenario ("recover from primary DB failover"). Each step is an **Action** chained with \`follows\` so the order is unambiguous.

For every step that has a non-trivial rollback, link a sibling Action with \`verb: rollback_*\` so the recovery path is also captured. Cross-reference monitoring + alert sources via **Reference** entities.`,
  },
  {
    name: "post-mortems",
    label: "Post-mortems",
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
    purpose:
      "Domain terminology: the canonical definitions of project-specific terms.",
    guidelines: `One **Reference** per term, with \`ref_type: document\` and \`locator\` pointing at the canonical source (or set to "internal" if the term is project-coined).

Each term's Reference should include in \`summary\` a 1-2 sentence definition. Use \`scopes\` to attach related terms to the same domain (e.g., \`scopes: [glossary, payments]\` for a payment-specific term).

When a term is renamed or deprecated, write a new Reference and link to the old via \`supersedes\`.`,
  },
  {
    name: "roadmap",
    label: "Roadmap",
    purpose:
      "Planned work: commitments and intentions about what will be built next.",
    guidelines: `An **Intent** for each planned outcome. Order intents with \`follows\` to express sequence.

When the team commits to a date, capture a **Decision** ("ship X by 2026-Q3") referencing the Intent. When the work starts, write an **Action** chained from the commitment Decision. When done, the Action's \`outputs\` close the loop.

Roadmap items that get cut should have their lifecycle set to \`abandoned\` rather than be deleted — the trail of "what we considered + dropped" is part of the rationale.`,
  },
];

/** Lookup a template by name. Returns undefined for unknown names. */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === name);
}
