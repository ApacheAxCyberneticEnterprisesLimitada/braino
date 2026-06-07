/**
 * Default Doco templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships curated templates describing common Doco shapes
 * such as business processes, glossaries, org charts, and decision-record
 * collections. Template names are plain handles.
 *
 * Each template ships:
 * - `description` — the description text rendered in the picker and
 *   bootstrap manifest.
 * - `policies` — at install time each entry seeds one row in the unified
 *   `policies` table, classified by a standalone `kind` (translated in
 *   host.ts): a prose-only entry becomes a `suggestion` (advisory; the
 *   prose IS the agent instruction); an entry with a `probabilistic`
 *   predicate becomes a `probabilistic` policy (LLM-judged; the `spec` is
 *   the agent instruction); a `descriptive` predicate folds into a
 *   `suggestion` (recorded, not enforced); any other predicate becomes a
 *   `deterministic` policy (engine-checked, keyed by `sub_kind`).
 *
 * The historical guidance_policies / node_authoring_policies split — and
 * the older Rule.kind overloading (guidance / authoring / tagged) — are
 * both gone: every policy now lives in the one `policies` table, and
 * meta-constraints are policies, not Rule nodes
 * (decision_01KRRR5BQ16ASY8HQEE0V499YG).
 */
import type { AuthoringPredicate, Lifecycle } from "@doco/shared";

export interface TemplatePolicy {
  /** The one-line statement of the policy. REQUIRED for a prose-only
   *  suggestion entry — there it IS the policy and seeds the suggestion's
   *  agent instruction. REQUIRED (and the sole human description) for a
   *  `deterministic` entry, whose structured predicate carries no prose.
   *  OMITTED for `probabilistic` and `edge-probabilistic` entries, where the
   *  `predicate.spec` already IS the human-readable instruction the judge and
   *  agents see — a separate summary would just duplicate it. */
  policy?: string;
  /**
   * Engine-readable predicate. When set, the seeder records a
   * `deterministic` policy — or a `probabilistic` one, for a
   * `probabilistic` predicate — so the check can run at capture time.
   */
  predicate?: AuthoringPredicate;
  /**
   * When set, the engine only fires this policy against candidates whose
   * `lifecycle` is in the list. Completeness and quality gates use this to
   * hold a node to the bar once it is proposed (`queued`) and accepted
   * (`active`) while leaving a `drafting` sketch unjudged.
   */
  fires_when_node_lifecycle?: Lifecycle[];
  /**
   * Override the seeded policy's `on_violation` behavior. Defaults
   * to "block" when unset. Use "warn" for soft / probabilistic rules
   * the author wants surfaced but not enforced (e.g. semantic
   * membership gates), and "log" for purely descriptive recording.
   */
  on_violation?: "block" | "warn" | "log";
}

export interface TemplatePerspectiveAttachment {
  /**
   * Slug of a perspective in the `perspectives` table. The host
   * resolves the slug at template-application time, so a template
   * referencing a slug that no longer exists silently skips it
   * rather than failing the whole Doco creation. Built-in `graph`
   * and `list` may be referenced to make either built-in the default
   * without duplicating its tab.
   */
  slug: string;
  /**
   * When true, this perspective becomes the new Doco's default tab,
   * superseding the `graph` default. Only the first `isDefault: true`
   * in the list takes effect — additional defaults are ignored.
   */
  isDefault?: boolean;
}

export interface DocoTemplate {
  name: string;
  /** Short readable label for the picker UI. */
  label: string;
  /** Recommended single-emoji icon. */
  icon: string;
  /** Description text rendered in picker and bootstrap surfaces. */
  description: string;
  /** Atomic policies seeded at install time. */
  policies: TemplatePolicy[];
  /**
   * Optional perspectives to attach on Doco creation. The built-in
   * perspectives (graph, list) are always attached even
   * if this list is empty; entries here append after them. The
   * process template ships `[{slug:"process"}]` so a Doco
   * created from that template arrives with the BPMN tab ready.
   */
  perspectives?: TemplatePerspectiveAttachment[];
  /**
   * When set, captures into a Doco created from this template default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The process template
   * uses `"drafting"` so authors can sketch incomplete processes
   * without tripping completeness rules.
   */
  defaultNodeLifecycle?: Lifecycle;
}

const DECISION_RECORD_NODE_TYPES = [
  "intent",
  "decision",
  "eval",
  "reference",
  "rule",
  "principal",
] as const;

interface DecisionRecordTemplatePolicyOptions {
  decisionMembershipSpec: string;
  qualityChecklist: string[];
  qualityFailure: string;
  guidance: string[];
}

function decisionRecordQualitySpec(opts: {
  checklist: string[];
  failure: string;
}): string {
  const checklist = opts.checklist.map((item, index) => `(${index + 1}) ${item}`).join(", ");
  return [
    "Check the Decision's `prose`, `question`, `chosen`, and `alternatives`.",
    `PASS when the record includes: ${checklist}.`,
    `FAIL with missing aspects when ${opts.failure}.`,
  ].join(" ");
}

// Completeness, uniqueness, quality, and domain-membership judgments hold a
// decision record to the decision-record bar from the moment it is *proposed*
// (`queued`) and keep holding it once it is *accepted* (`active`). A
// `drafting` record is an unjudged sketch — its `chosen` resolution may still
// be blank — so these gates skip it: an author sketches freely in `drafting`
// and queues (proposes) the record once it states a question, a choice, and
// the alternatives. Membership stays gated too, because a half-formed sketch
// is hard to classify by domain; once a record is complete enough to propose,
// it is complete enough to place. The node-type allowlist is the deliberate
// exception — it is a structural invariant about what may exist in the Doco at
// all, not a property of an in-force record, so it fires at every stage.
const PROPOSED_OR_ACCEPTED: Lifecycle[] = ["queued", "active"];

function decisionRecordPolicies(opts: DecisionRecordTemplatePolicyOptions): TemplatePolicy[] {
  return [
    {
      on_violation: "warn",
      predicate: {
        kind: "probabilistic",
        spec: opts.decisionMembershipSpec,
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: PROPOSED_OR_ACCEPTED,
    },
    {
      policy:
        "Only Intent, Decision, Eval, Reference, Rule, and Principal belong in a decision-record Doco. Actions, Logs, States, and Ideas belong in sibling Docos unless promoted into an actual decision record.",
      predicate: {
        kind: "requires_node_type",
        node_types: [...DECISION_RECORD_NODE_TYPES],
      },
    },
    {
      // Edge-type allowlist (the edge analogue of the node-type allowlist above).
      // A decision record links a Decision to its supporting Intents/Evals/
      // References (`supports`), names accountability (`attributed_to`), connects
      // related or superseding records (`relates_to` / `replaces`), and cites
      // sources (`derived_from`). BPMN sequence flow and Rule guards have no
      // place here, so `flows_to` / `constrained_by` / `has_parent` are barred.
      policy:
        "Only these relationship edge types may be used in a decision-record Doco: `supports`, `attributed_to`, `relates_to`, `replaces`, `derived_from`. Process flow (`flows_to`), Rule guards (`constrained_by`), and hierarchy (`has_parent`) belong in other Doco kinds.",
      predicate: {
        kind: "requires_edge_type",
        edge_types: ["supports", "attributed_to", "relates_to", "replaces", "derived_from"],
      },
    },
    {
      policy:
        "Every proposed or active decision-record Decision declares `question`, `chosen`, and `alternatives`: the issue being decided, the selected resolution, and the options considered. A `drafting` sketch is exempt — its `chosen` may stay blank while the author is still thinking.",
      predicate: {
        kind: "requires_field",
        fields: ["question", "chosen", "alternatives"],
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: PROPOSED_OR_ACCEPTED,
    },
    {
      on_violation: "warn",
      policy:
        "Proposed and active decision-record Decisions should have unique `question` values. If the same question is revisited, retire or supersede the old record and link it to the successor rather than silently rewriting history.",
      predicate: {
        kind: "unique_field",
        field: "question",
        case_fold: true,
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: PROPOSED_OR_ACCEPTED,
    },
    {
      on_violation: "warn",
      predicate: {
        kind: "probabilistic",
        when_node_type: ["decision"],
        spec: decisionRecordQualitySpec({
          checklist: opts.qualityChecklist,
          failure: opts.qualityFailure,
        }),
      },
      fires_when_node_lifecycle: PROPOSED_OR_ACCEPTED,
    },
    {
      policy:
        "Lifecycle is the decision's status. `drafting` is a private sketch — the `chosen` resolution can stay blank while you think. Queue (propose) the record to put it up for review: completeness and quality gates begin at `queued`, so a proposal already reads as a real decision record. `active` marks the decision accepted and in force; `retired` deprecates or supersedes it. Capture rough thinking as `drafting`, propose it as `queued`, accept it by activating, and never edit an accepted record in place — supersede it.",
    },
    {
      policy:
        "Decision records are append-only once accepted (active): while a record is still `drafting` or `queued` you may revise it freely, but after it goes `active` you correct or replace it by retiring or superseding the old Decision and creating a successor — not by editing away the original context, rationale, or rejected alternatives.",
    },
    {
      policy:
        "Use References for source material and implementation evidence, Rules for enduring policy that falls out of a decision, Evals for validation or follow-up checks, and Intents for the goal or outcome the decision serves.",
    },
    {
      policy:
        "Support nodes are allowed when they clearly support a Decision in this Doco: Intents state goals or outcomes, Rules carry enduring guidance, References preserve source material, and Evals validate decisions or follow-up checks. Principal nodes are optional accountability support for stable owners or review bodies; when a Principal node is unnecessary, name accountability in prose.",
    },
    ...opts.guidance.map((policy) => ({ policy })),
  ];
}

/**
 * Process fires its completeness + shape policies on the two
 * *committed* lifecycle stages — `queued` (ready, awaiting activation) and
 * `active` (in force) — and exempts only `drafting`.
 *
 * Rationale (the `queued` stage): the node lifecycle is now
 * `drafting → queued → active → retired`. A node an author has explicitly
 * `queue`d is asserting it is ready to go live, so it must already satisfy
 * the same actor attribution (an `attributed_to` edge to a Principal), the
 * process it belongs to (a `has_parent` edge to its process Action), and
 * forward `flows_to` wiring an `active` node does — otherwise "ready" is a lie
 * the BPMN renderer can't draw. Only a `drafting` sketch may be incomplete.
 *
 * This is scoped to process on purpose: it is the one template
 * that defaults new nodes to `drafting` and carries a real
 * draft → queue → activate authoring story. Templates that default new
 * nodes straight to `active` (decision-records, glossaries, org-chart)
 * rarely pass through `queued`, so they still fire on `["active"]`.
 *
 * This covers BOTH the completeness/shape gates and the flow-node
 * Principal-attachment gates (an Action is `performed_by`, a gateway Decision
 * `decided_by` a Principal). All of them fire on the committed stages only, so
 * a `drafting` sketch may be both incomplete AND unowned while the author
 * iterates — and is held to the full bar once it is committed. (`retired` is
 * excluded too: a winding-down node isn't re-judged, and the runner's
 * terminal-skip drops these `requires_edge` checks anyway.)
 */
const BUSINESS_PROCESS_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

export const DEFAULT_DOCO_TEMPLATES: DocoTemplate[] = [
  {
    name: "architectural-decisions",
    label: "Architectural decisions",
    icon: "🏛️",
    description:
      "Document architectural decision records — system structure, interfaces, infrastructure, quality attributes, constraints, alternatives, and consequences.",
    perspectives: [{ slug: "list", isDefault: true }],
    policies: decisionRecordPolicies({
      decisionMembershipSpec:
        "PASS for ADR Decisions, technology-selection Decisions, and security/privacy architecture Decisions that record system structure, API or integration boundaries, infrastructure, quality attributes, operational constraints, compliance architecture, implementation evidence, or architecture validation, including Decisions supported by References and Evals. FAIL for product roadmap or pricing choices (route to product-decisions), UI or interaction design choices (design-decisions), data-definition or governance decisions (data-decisions), raw incidents, or implementation tasks with no architectural consequence.",
      qualityChecklist: [
        "context/problem",
        "decision drivers such as quality attributes, constraints, or forces",
        "realistic alternatives considered",
        "rationale for the chosen architecture",
        "consequences/trade-offs/risks",
        "implementation, migration, rollback, or revisit implications",
      ],
      qualityFailure:
        "it only states a choice without rationale, lacks alternatives, omits consequences, or leaves no path for implementation/review",
      guidance: [
        "Create an architectural Decision for choices that are hard to reverse or broadly consequential: platform/runtime choices, service boundaries, data ownership across systems, API contracts, security controls, reliability targets, deployment topology, build/release architecture, or cross-team technical standards.",
        "Architectural Decisions that create enduring technical rules should spawn or link Rules, such as API compatibility rules, service ownership rules, dependency constraints, or security requirements.",
        "Link implementation PRs, migration plans, diagrams, benchmark results, threat models, and incident learnings as References so the ADR remains explainable after the code has moved on.",
        "Architecture records link the accountable technical owner or review group with an `attributed_to` edge from the Decision to that Principal, or name it in prose if no Principal node exists yet, and call out product, design, data, security, or operations stakeholders when the decision crosses those boundaries.",
      ],
    }),
  },
  {
    name: "product-decisions",
    label: "Product decisions",
    icon: "🧭",
    description:
      "Document product decision records — user/customer evidence, scope, positioning, pricing, roadmap choices, success metrics, alternatives, and revisit triggers.",
    perspectives: [{ slug: "list", isDefault: true }],
    policies: decisionRecordPolicies({
      decisionMembershipSpec:
        "PASS for product Decisions about target users, product goals or outcomes, product principles or commitments, customer/research evidence, experiment or metric interpretation, pricing, packaging, roadmap priority, launch strategy, or deliberate decisions not to build something, including Decisions supported by References and Evals. FAIL for engineering or infrastructure implementation choices (route to architectural-decisions), visual or interaction design details (design-decisions), data-governance or metric-definition choices (data-decisions), one-off support events, or unpromoted feature ideas with no decision yet.",
      qualityChecklist: [
        "the user/customer problem and affected segment",
        "strategic or OKR alignment",
        "evidence such as research, feedback, analytics, sales/support signal, or experiment data",
        "assumptions and constraints",
        "realistic alternatives including the status quo or not-building option",
        "trade-offs and expected impact",
        "a success/failure metric or learning goal",
        "a decision owner/approval role or revisit trigger",
      ],
      qualityFailure:
        "it reads as a feature wish, ungrounded opinion, or roadmap assertion without evidence and metrics",
      guidance: [
        "Record `we will not do X` product calls when the choice changes scope, user expectations, sales promises, or future roadmap reasoning; negative decisions are often more valuable than shipped-feature notes.",
        "Use Evals for experiments, A/B tests, metric reviews, or qualitative checks that prove whether the product Decision worked, and link follow-up Decisions when the evidence changes the course.",
        "Product Decisions separate reversible experiments from committed strategy: a reversible two-way-door test can sit in `queued` (proposed and time-boxed) while you gather evidence, while a one-way-door commitment moves to `active` only with explicit approval and a revisit trigger.",
        "Use References for customer interviews, tickets, analytics, opportunity assessments, pricing research, launch notes, and competitive evidence rather than burying source material inside the Decision prose.",
      ],
    }),
  },
  {
    name: "design-decisions",
    label: "Design decisions",
    icon: "🎨",
    description:
      "Document design decision records — UX, service, interaction, content, accessibility, design-system, and research-backed trade-offs.",
    perspectives: [{ slug: "list", isDefault: true }],
    policies: decisionRecordPolicies({
      decisionMembershipSpec:
        "PASS for design Decisions about user journeys, interaction patterns, service flows, content strategy, accessibility behavior, design-system conventions, visual hierarchy with product meaning, research findings, prototypes, or usability validation, including Decisions supported by Figma or research References and usability/accessibility Evals. FAIL for backend or infrastructure architecture (route to architectural-decisions), product scope or roadmap priority without UX implications (product-decisions), data governance or schema decisions (data-decisions), or cosmetic preference notes with no user or system rationale.",
      qualityChecklist: [
        "the user journey, service moment, or interface state being decided",
        "evidence from research, support, analytics, accessibility review, or product constraints",
        "alternatives considered, preferably linked to artifacts",
        "chosen design pattern and rationale",
        "affected states including empty/error/loading/permission/responsive states when relevant",
        "accessibility, content, localization, or design-system implications",
        "trade-offs and risks",
        "validation or rollout plan",
      ],
      qualityFailure:
        "it only says what the UI looks like without explaining users, evidence, alternatives, states, or validation",
      guidance: [
        "Attach screenshots, prototypes, Figma files, research notes, usability recordings, audits, and content examples as References so later readers can see what the decision actually changed.",
        "Record significant unshipped design work when it shaped the eventual answer; rejected explorations are part of the rationale, not throwaway history.",
        "Design-system Decisions that establish reusable behavior should produce Rules for component usage, accessibility expectations, content patterns, or interaction constraints.",
        "Use Evals for usability tests, accessibility audits, design QA checklists, or content reviews that determine whether the design Decision still holds.",
      ],
    }),
  },
  {
    name: "data-decisions",
    label: "Data decisions",
    icon: "🗃️",
    description:
      "Document data decision records — source-of-truth choices, schemas, contracts, metric definitions, governance, quality, lineage, retention, privacy, and access.",
    perspectives: [{ slug: "list", isDefault: true }],
    policies: decisionRecordPolicies({
      decisionMembershipSpec:
        "PASS for data Decisions about source-of-truth ownership, canonical metric or entity definitions, schema and contract choices, lineage, quality/freshness targets, retention, privacy classification, access controls, migration/backfill plans, or consumer-impact validation, including Decisions supported by data contract References and quality or freshness Evals. FAIL for UI or interaction design decisions (route to design-decisions), product roadmap or pricing choices (product-decisions), pure application or infrastructure architecture with no data ownership or semantics impact (architectural-decisions), or raw pipeline run Logs.",
      qualityChecklist: [
        "the data asset, metric, event, dataset, or contract being decided",
        "accountable owner or steward",
        "producers and consumers or affected systems",
        "canonical source of truth and semantic definition",
        "schema/contract or compatibility implications",
        "classification, privacy, access, and retention considerations when relevant",
        "data quality/freshness/SLA expectations and lineage",
        "migration, backfill, rollback, or downstream impact",
        "monitoring or revisit trigger",
      ],
      qualityFailure:
        "it records a data choice without ownership, semantics, consumers, governance, or operational impact",
      guidance: [
        "Prefer machine-readable data contracts where possible, and link them as References; the Decision explains why the contract exists while the contract defines the enforceable schema and expectations.",
        "Metric and source-of-truth Decisions should define exactly what is included, excluded, and time-bounded so dashboards, experiments, and product claims do not drift into incompatible meanings.",
        "Breaking data changes require a migration/backfill plan, downstream-consumer notice, compatibility strategy, and rollback or reconciliation path before the Decision is active.",
        "Use Rules for enduring governance constraints such as access tiers, retention limits, PII handling, ownership boundaries, and quality thresholds; use Evals to monitor freshness, completeness, drift, or contract compliance.",
      ],
    }),
  },
  {
    // Glossaries define product and domain language. Each term entry is a
    // Reference whose **prose (`reference`) is the word being defined** — the
    // bare headword — while the **definition lives in the `definition`
    // attribute**, off the prose. Keeping the definition out of the prose
    // matters because a node's name is the first line of its prose
    // everywhere in Doco (List, Graph, search, the node dialog, and the
    // Glossary headword all derive from it): if the definition were the
    // prose, the definition would become the term's name. So the prose holds
    // only the term, and the meaning sits in `definition`. `alternatives`
    // carries aliases / rejected labels.
    //
    // Why a Reference (not a Decision)? A glossary term is a stable
    // reference to a named thing, not a choice between alternatives with a
    // rationale — that is the shape of a Reference, and it is also the node
    // a glossary already uses to cite an external source. So a single node
    // type covers both a defined term and the sources it derives from: a
    // term entry is a Reference with a `definition`, a cited source is a
    // Reference with a `locator`.
    //
    // Two stages, on purpose. A glossary is a reference work, so a term
    // entry is either the canonical answer (`active`) or a deprecated one
    // kept for lookup (`retired`) — exactly the two stages a policy uses.
    // The framework's other lifecycle stages add nothing here: `queued`
    // (provisional-but-ready, e.g. an open PR awaiting approval) has no
    // glossary meaning — a term is either the canonical answer or it isn't —
    // and `drafting` is just a private scratch state for an unfinished term,
    // not part of the glossary yet. So a captured term lands `active` (no
    // `defaultNodeLifecycle` override) and the completeness gates fire on
    // `active`; a `drafting` stub is exempt until it is activated, and a
    // `retired` term winds down without re-running the gates. (Contrast
    // process, which defaults to `drafting` so a flow can be
    // wired up incrementally.)
    //
    // Term relationships are first-class edges: `relates_to` is the
    // associative "see also" link (confusable, broader/narrower, or
    // homograph terms); `replaces` links a retired term to its replacement;
    // `derived_from` cites the external source a borrowed term comes from;
    // and an Eval `supports` the term it checks.
    //
    // The dictionary-styled Glossary perspective is the natural reading
    // surface for terminology, so a Doco created from this template opens
    // directly on it. Graph + list defaults stay attached behind.
    name: "glossaries",
    label: "Glossaries",
    icon: "📚",
    description:
      "Document product and domain terminology — canonical terms, definitions, aliases, replacement links, sources, and consistency checks.",
    perspectives: [{ slug: "glossary", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in glossaries when it defines product or domain terminology (as a Reference term entry), cites an authoritative source, states a terminology usage rule, or checks terminology consistency. PASS for term-entry References, References to source glossaries/specs/docs, terminology usage Rules, and Evals that scan terminology consistency. FAIL for glossary scope statements, feature implementation work, process flows, org charts, runtime incidents, or state-machine stages.",
          when_node_type: ["reference", "rule", "eval"],
        },
      },
      {
        policy:
          "Only Reference, Rule, and Eval are glossary graph nodes. Term entries are References (the word in the prose, the meaning in `definition`); Decisions, Intents, Actions, Logs, States, Ideas, and Principals have their own homes.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["reference", "rule", "eval"],
        },
      },
      {
        // Edge-type allowlist. A glossary wires terms together with `relates_to`
        // ("see also"), cites external sources with `derived_from`, deprecates a
        // term toward its replacement with `replaces`, and links an Eval to the
        // term it checks with `supports`. Actor/flow/guard/hierarchy edges have
        // no glossary meaning, so they are barred.
        policy:
          "Only these relationship edge types may be used in a glossary Doco: `relates_to`, `derived_from`, `replaces`, `supports`. Others (`flows_to`, `attributed_to`, `constrained_by`, `has_parent`) belong in other Doco kinds.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: ["relates_to", "derived_from", "replaces", "supports"],
        },
      },

      // ── Term entry References ──────────────────────────────────
      {
        // One combined quality judge for term-entry References. It is a
        // quality nudge, not an integrity constraint, so it WARNs rather
        // than blocking — a single judge misfire never loses the author's
        // work. It folds together the two checks this template is built
        // around — the prose is the *word*, the definition lives in the
        // *attributes* — plus the one-concept and acronym aspects, in one
        // judge call (cutting latency and the misfire surface). A Reference
        // that is purely a cited external source, not a term entry, is OUT
        // OF SCOPE and PASSES.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["reference"],
          spec: "Judge a glossary term-entry Reference on four aspects; report each failing aspect with a reason, but treat them as warnings, not hard errors. First decide scope: if this Reference is purely a cited external source (it points at a doc/spec/URL the glossary borrows from, with no term to define), it is OUT OF SCOPE — PASS every aspect. Otherwise judge a term entry. (a) PROSE IS THE TERM: PASS when the prose is the bare word or phrase being defined — the headword — optionally with a disambiguating qualifier like `Order (commerce)`; FAIL when the prose is instead a definition sentence or paragraph. The definition belongs in the `definition` attribute, NOT in the prose, because the prose becomes the node's name and the dictionary headword. (b) DEFINITION IN ATTRIBUTES: PASS when the definition lives in the node's attributes — the `definition` field (or another attribute that carries the meaning) — and reads as a usable definition: a concise definition AND the product or domain scope where the term applies AND at least one concrete example OR non-example (EITHER an example or a non-example is sufficient, do not require both). FAIL when no attribute carries a usable definition, when the definition is crammed into the prose, or when it merely restates the headword instead of explaining it (a circular definition such as `a workspace is a workspace`). (c) ONE CONCEPT: PASS when the entry defines one concept or one canonical term; FAIL when it defines multiple independent terms, bundles a term with an unrelated policy, or is a catch-all for several concepts. (d) ACRONYMS AND ABBREVIATIONS: only inspect the headword in the prose. If the headword is itself an acronym or abbreviation, PASS when the `definition` expands it at least once and states whether the short form is acceptable in product/docs/UI copy; FAIL when it is left unexpanded. Incidental abbreviations that merely appear in the definition body (not the headword) are OUT OF SCOPE — ignore them. If the headword is not an acronym, this aspect PASSES.",
        },
        fires_when_node_lifecycle: ["active"],
      },

      // ── Eval shape ─────────────────────────────────────────────
      {
        policy: "Every active glossary Eval has a `supports` edge to the term it checks.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: ["active"],
      },
      {
        policy:
          "Every active glossary Eval declares `how_to_run` so terminology consistency checks can be rerun.",
        predicate: {
          kind: "requires_field",
          fields: ["how_to_run"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: ["active"],
      },
      {
        // Quality nudge, not an integrity constraint: warn rather than block
        // so a borderline `how_to_run` (or a judge misfire) never loses the
        // author's Eval. The deterministic requires_field gate above still
        // blocks a truly missing field.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["eval"],
          spec: "Check the Eval's `how_to_run` field. PASS when it gives a concrete rerun path: an exact command, search query, URL, script, or manual review procedure, plus the doc/code/product scope to inspect. FAIL when it is vague (`review docs`, `check terminology`) or depends on unstated context.",
        },
        fires_when_node_lifecycle: ["active"],
      },

      // ── Guidance ───────────────────────────────────────────────
      {
        // The model this template is built around — see the block comment.
        policy:
          "A glossary term entry is a Reference: put the **word being defined** in the prose (it becomes the headword) and the **definition** — meaning, scope, and an example or non-example — in the `definition` attribute, never in the prose itself.",
      },
      {
        // The deliberate two-stage stance — see the block comment above.
        policy:
          "A glossary is a reference work: a term entry is either the canonical answer (`active`) or a deprecated one kept for lookup (`retired`). Capture a term and it lands `active`; `retire` it when it is superseded, pointing at the successor with a `replaces` edge. You may stub an unfinished term as `drafting` while you work on it, but it is not part of the glossary — and the completeness checks do not apply — until you `activate` it. The framework's `queued` stage has no glossary meaning, so this template stays two-stage like policies do.",
      },
      {
        policy:
          "When aliases, synonyms, misleading labels, or rejected labels exist for the same concept, record them in `alternatives`; otherwise omit `alternatives` rather than inventing filler.",
      },
      {
        policy:
          "When two distinct concepts share a surface form (homographs, e.g. `Order` in commerce vs. `Order` as a sort operation), give each its own Reference and disambiguate the headword prose with a qualifier — `Order (commerce)` vs. `Order (sorting)` — so every entry stays uniquely addressable.",
      },
      {
        policy:
          'Connect related glossary terms with `relates_to` edges — the associative "see also" link — instead of leaving entries isolated, so the vocabulary reads as a navigable network. Link a term to the ones it is easily confused with, its broader or narrower concepts, and the homographs it shares a surface form with. Change a link by retiring the old edge and adding a new one, not by editing endpoints in place; deprecation links use `replaces` instead.',
      },
      {
        policy:
          "Borrowed, standards-based, or industry terms cite their source: add a Reference for the external glossary, spec, or doc and link the term to it with a `derived_from` edge. Product-internal terms state that they are product-specific so readers don't mistake them for external standards.",
      },
      {
        policy:
          "Retired glossary term References point at the replacement term with a `replaces` edge when an old term appears in historical docs, UI, tickets, APIs, or code. Keep the deprecated term visible so readers still understand old references. Re-point by retiring the old edge and adding a new one.",
      },
      {
        policy:
          "Use Rules for terminology usage policies, such as banned words, capitalization conventions, UI copy constraints, or when two related terms must not be used interchangeably.",
      },
      {
        policy:
          "Agents read `GET /<handle>/api/authoring-contract.json` for the live field and edge vocabulary, then write terms with `POST /<handle>/api/changesets.json` — creating the term Reference (word in the prose, meaning in `definition`) together with its `relates_to`, `derived_from`, or `replaces` edges in the same changeset so an entry never lands isolated.",
      },
    ],
  },
  {
    // Repeatable business processes modeled on BPMN swimlanes and
    // gateways. Sequence flow is explicit via first-class `flows_to`
    // edges; flow normally runs forward, but
    // rework loops may route back through a gateway. Generic Doco
    // dependency / rationale edges remain associations and are not
    // treated as BPMN arrows.
    //
    // Lifecycle: nodes default to `drafting` so a process can be sketched
    // freely; the completeness + shape rules — including `has_parent` process
    // membership and naming the actor / decider Principal (an Action's and a
    // gateway Decision's `attributed_to` edge to a Principal) — fire on the
    // committed stages (`queued` and `active`) only
    // (BUSINESS_PROCESS_COMMITTED_LIFECYCLES), so a step can be drafted before
    // its actor, decider, or parent process/pool is chosen, and is held to the
    // full bar only once it is committed.
    name: "process",
    label: "process",
    icon: "🔁",
    description:
      "Document repeatable business processes — the flow of work through actors, gateways, and milestones to a business outcome. Inspired by BPMN swimlanes and gateways.",
    defaultNodeLifecycle: "drafting",
    // Ship the BPMN perspective pre-attached and as the default tab,
    // so a freshly-created process Doco opens directly on
    // the swim-lane view (where the template's authoring rules are
    // most naturally visible). Graph + list defaults are still
    // attached behind it.
    perspectives: [{ slug: "process", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Soft semantic gate — fires as a `warn`, not a block. The author
        // opted into the template by installing it; the gate is meant to
        // surface "this looks like a one-off" so they can reconsider,
        // not to second-guess their template choice. Rule nodes are
        // exempt (they govern process authoring rather than being
        // process content) — handled by omitting "rule" from
        // when_node_type. Personal / informal workflows pass too:
        // the gate cares about "workflow with steps, actors, outcome",
        // not "this is paid work at a company".
        //
        // State is ALSO exempt. A milestone State viewed in isolation
        // ("loan approved", "incident mitigated") genuinely reads like a
        // bare state-machine stage, so the judge warned on the very
        // initial/terminal States the template REQUIRES — a false-positive
        // on every process. States are structural flow nodes admitted by
        // the node-type allowlist; their quality is governed by the
        // milestone-naming probabilistic policy below, not this membership
        // gate.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in process when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. Pass when the candidate describes a step, gateway, milestone, validation, reference, or policy for such a workflow. Fail only when the candidate is a one-off incident with no repeatable structure, a UI-specific user journey, or a pure state machine without a workflow outcome.",
          when_node_type: ["action", "decision", "eval", "reference"],
        },
      },
      {
        // Deterministic node-type allowlist. Logs (recorded executions)
        // live in a sibling Doco and are surfaced here via Reference;
        // Ideas live in their own home until promoted. Policy records are
        // Doco-scoped metadata and bypass template membership gates in the
        // authoring evaluator.
        policy:
          "Only Action, Decision, State, Eval, Reference, Rule, and Principal belong here. A process is an Action with one or more flow nodes linked to it by `has_parent` (its members); there is no separate Intent node. Logs (recorded executions) live in a sibling Doco and are referenced from here; Ideas live in their own home until promoted.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["action", "decision", "state", "eval", "reference", "rule", "principal"],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist
        // above). A business process wires sequence flow (`flows_to`), process
        // membership / subprocess nesting (`has_parent`, flow node → its parent
        // process Action), validation/rationale/evidence (`supports`), actor /
        // decider attribution (`attributed_to`), policy guards
        // (`constrained_by`), supersession (`replaces`), and provenance
        // (`derived_from`). Bare associative links (`relates_to`) have no BPMN
        // meaning, so they are barred — keeping a process graph drawable as
        // swimlanes + sequence flow.
        policy:
          "Only these relationship edge types may be used in a process Doco: `flows_to`, `has_parent`, `supports`, `attributed_to`, `constrained_by`, `replaces`, `derived_from`. A flow node's `has_parent` to a process Action is its pool membership. Bare `relates_to` links belong in other Doco kinds.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "flows_to",
            "has_parent",
            "supports",
            "attributed_to",
            "constrained_by",
            "replaces",
            "derived_from",
          ],
        },
      },
      {
        // Deterministic floor under the LLM prose judge below: a handful of
        // tokens are NEVER legitimate business prose — camelCase BPMN element
        // types and generated `Gateway_…`/`Task_…`/`SequenceFlow_…` ids, plus
        // the importer's "user asks:" scaffolding. Catch those cheaply and
        // deterministically; the ambiguous "is 'source'/'implementation'
        // business language?" calls stay with the judge.
        policy:
          "Process prose must not contain raw BPMN/import scaffolding tokens — camelCase BPMN element types or generated element ids leaked from an importer.",
        predicate: {
          kind: "forbids_field_pattern",
          fields: ["action", "decision", "question", "chosen", "state", "rule", "eval", "name"],
          pattern:
            "(exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway|(?:Gateway|Task|UserTask|ServiceTask|SequenceFlow|StartEvent|EndEvent|BoundaryEvent|SubProcess|DataObject)_[A-Za-z0-9]+|user asks:)",
          flags: "i",
          when_node_type: ["action", "decision", "state", "eval", "rule", "principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Import provenance belongs in structured metadata, References,
        // or history, not in the labels/prose that BPMN readers scan.
        // This stays LLM-judged because terms like "source" and
        // "implementation" can be legitimate business language; the bad
        // case is raw importer/debug scaffolding leaking into process text.
        on_violation: "block",
        predicate: {
          kind: "probabilistic",
          spec: 'Check the candidate\'s visible user-facing text fields, including name, action, decision, question, chosen, state, rule, and eval text. PASS when the text reads as business-process language for an operator or process reader, and any BPMN/source/import/code-evidence details are absent from visible prose or kept only in structured metadata, References, or audit/history. FAIL when visible text contains raw import scaffolding or implementation/source metadata, including phrases or patterns like "BPMN gateway", "BPMN task", "Gateway_...", "Implementation status", "Code evidence", "Source type", "exclusiveGateway", "user asks:", raw BPMN ids, generated object ids, or notes about code evidence discovered during import. Do not fail merely because a real business term happens to mention a job type, gateway, source, or implementation in ordinary process language; fail only when the prose exposes importer/debug/source metadata instead of the process meaning.',
          when_node_type: ["action", "decision", "state", "eval", "rule", "principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Principal shape ──────────────────────────────────────────
      {
        // Principals are the lane owners in the BPMN perspective.
        // Keep this as a warning: the principal endpoint permits a
        // quick name-only create, and the template should nudge
        // authors toward richer swim lanes without blocking a sketch.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Principal's `prose`. PASS when it clearly names a process actor — a role, team, external party, or system — and explains what responsibility or boundary it owns in this process. FAIL if it reads like an uncontextualized org-chart person, a vague label (`user`, `team`, `system`) with no process responsibility, or an empty shell with only a bare name.",
          when_node_type: ["principal"],
        },
      },

      // ── Process shape (prose guidance) ──────────────────────────
      {
        // A process is an Action with `has_parent` children. Its prose names
        // the whole repeatable process (a verb + object, e.g. `publish a
        // job`), while its member Actions name the individual steps. There is
        // no separate Intent node and no calling-Action ↔ purpose-Intent
        // pairing: the process Action *is* the pool, and a member Action that
        // itself has children simply renders as a collapsed subprocess.
        policy:
          "Model a process as an Action that names the whole repeatable activity (a verb + object, e.g. `publish a job`) and give it member flow nodes via `has_parent` edges pointing at it. A step that is itself a whole process becomes a subprocess automatically — it is a member Action that also has its own `has_parent` children; do not create a separate purpose node for it.",
      },

      // ── Action shape ────────────────────────────────────────────
      {
        // Completeness — fires on the committed stages only (see
        // BUSINESS_PROCESS_COMMITTED_LIFECYCLES): a `drafting` Action may be
        // sketched without an actor, but a committed step must be attributed to
        // the Principal who performs it. With edge roles gone, an Action's
        // `attributed_to` edge to a Principal IS the performer link — the source
        // node type (action) carries that meaning. Authors create the Action and
        // its `attributed_to` edge together in one changeset.
        policy:
          "Every committed (`queued` or `active`) Action in process is attributed to the Principal who performs it — an `attributed_to` edge from the Action to that Principal. A `drafting` sketch may defer this — naming the actor is not required while drafting.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Process membership — one rule for all three flow-node types. A flow
        // node belongs to a process through a `has_parent` edge to the process
        // Action; that edge IS its BPMN pool membership. A hard block once
        // committed: an unattached step has no pool. The one structural
        // exemption (`exempt_when_incoming_edge_type: has_parent`) excuses a
        // top-level process Action — the root, which is the TARGET of its
        // children's `has_parent` and so needs no parent of its own.
        policy:
          "Every committed (`queued` or `active`) flow node in process — Action, gateway Decision, or milestone/event State — links to the process it belongs to with a `has_parent` edge to that process Action. Without it the BPMN renderer can't place the node in a pool. A top-level process Action (the target of its members' `has_parent`) is the root and is exempt; a `drafting` sketch may defer the link.",
        predicate: {
          kind: "requires_edge",
          edge_type: "has_parent",
          target_node_type: "action",
          // A process Action (the target of incoming `has_parent` children) is a
          // pool, not a member — it needs no parent of its own.
          exempt_when_incoming_edge_type: "has_parent",
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // The CEILING that complements the membership FLOOR above: a flow node's
        // `has_parent` to a process Action is its pool membership, capped at one,
        // so a committed flow node belongs to EXACTLY one BPMN pool. A node
        // linked to two parent processes is ambiguous — the renderer can't decide
        // which pool owns it. A `drafting` sketch is exempt. Re-point by retiring
        // the old `has_parent` edge before adding the new one; endpoints are immutable.
        policy:
          "Every committed (`queued` or `active`) flow node in process belongs to AT MOST one process: it carries at most one `has_parent` edge to a process Action. A node linked to two parent processes is ambiguous — the BPMN renderer can't place it in a single pool. A `drafting` sketch is exempt. Re-point by retiring the old `has_parent` edge before adding the new one.",
        predicate: {
          kind: "limits_edge",
          edge_type: "has_parent",
          target_node_type: "action",
          max_count: 1,
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Atomic activity prose — surface umbrella phases and
        // implementation chores divorced from business meaning. Fires as a
        // `warn`, not a block: it's an LLM-judged style check, so a blocking
        // verdict both stopped legitimate single-verb steps ("Reviews the
        // legal terms") and was non-deterministic (an identical retry could
        // pass). Warn keeps the nudge without trapping the author. The spec
        // now PASSES an ordinary single-verb business step and reserves the
        // FAIL for true umbrellas and conjunction ("examine AND treat")
        // steps that bundle two activities.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Action's `prose` and `verb`. PASS when the text names a single business activity the named actor performs — an ordinary single-verb step like `review the legal terms`, `approve the invoice`, or `pack the order` PASSES. FAIL with reason only if the text (a) is a vague umbrella phase covering many steps (e.g. `handle request`, `do the thing`, `process order`), (b) bundles two distinct activities joined by `and` (e.g. `examine and treat the patient`), or (c) is an implementation chore divorced from business meaning (e.g. `call API`, `update row`, `write to DB`).",
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      // ── Decision shape ──────────────────────────────────────────
      {
        // Structural floor for a gateway: it branches, so it carries ≥2
        // outgoing `flows_to` edges. A single-exit Decision is a plain step,
        // not a gateway. Deterministic; the exhaustiveness/enum-coverage of
        // those branches is the LLM judge's job, below.
        policy:
          "A gateway Decision branches: it has at least two outgoing `flows_to` edges. A Decision with a single exit is a step, not a gateway.",
        predicate: {
          kind: "requires_edge",
          edge_type: "flows_to",
          min_count: 2,
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Exhaustive branches: question reads as yes/no or enumerated,
        // and the alternatives list either has a default/else branch
        // or covers every enum value.
        predicate: {
          kind: "probabilistic",
          spec: "Check the Decision's `question`, `alternatives`, and any outgoing `flows_to` branch labels/conditions. PASS when the question reads as yes/no or an enumeration, AND the alternatives / outgoing branches either include an explicit default/else branch or name every enumerated value. FAIL with reason if the question has uncovered cases or if a default/else is missing where enum coverage isn't visibly complete.",
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // A gateway routes the flow; strict BPMN leaves the diamond itself
        // unowned and lets the surrounding activities carry accountability.
        // We make that accountability explicit instead: every gateway is
        // attributed to the Principal answerable for the call, via an
        // `attributed_to` edge. With roles gone, a Decision's `attributed_to`
        // edge to a Principal IS its decider (source node type = decision).
        // Mirrors the Action gate, and like it fires on the committed stages only
        // (see BUSINESS_PROCESS_COMMITTED_LIFECYCLES): a `drafting` gateway may be
        // sketched without a decider, but a committed one must name it or it
        // floats into the BPMN "Unassigned" lane.
        policy:
          "Every committed (`queued` or `active`) gateway Decision in process is attributed to the Principal answerable for the call — an `attributed_to` edge from the Decision to that Principal. A `drafting` sketch may defer this. A gateway with no such Principal floats into the Unassigned lane.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── State shape & sequence wiring ───────────────────────────
      {
        // Doco-level existence ("≥1 initial, ≥1 terminal") stays prose: the
        // per-candidate evaluator can't assert "the graph contains a terminal
        // State". The per-node shape rules below ARE engine-checked.
        policy:
          "A business process has ≥1 committed (`queued` or `active`) initial State and ≥1 committed terminal State. Every process starts somewhere and ends at a business outcome (or an explicitly cancelled outcome).",
      },
      {
        // Milestone names must be unambiguous within the Doco. Deterministic:
        // `unique_field` compares the candidate's `state` against other active
        // States.
        policy:
          "Each `state` milestone name is unique among the process's committed States, so a reader can name a milestone unambiguously.",
        predicate: {
          kind: "unique_field",
          field: "state",
          case_fold: true,
          when_node_type: ["state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // The sequence-flow completeness invariant — formerly prose-only, now
        // engine-checked. A committed flow node must be wired into the process:
        // reachable (≥1 incoming `flows_to`) unless it is an initial State, and
        // leading somewhere (≥1 outgoing `flows_to`) unless it is a terminal
        // State — which conversely must carry NO outgoing `flows_to`. This is
        // what stops an agent from queuing/activating a dangling mid-flow node.
        policy:
          "Flow runs forward from the initial State: each committed (`queued` or `active`) initial State has ≥1 outgoing `flows_to` edge, every non-initial flow node is reachable through an incoming `flows_to`, and every non-terminal flow node has ≥1 outgoing `flows_to`. Terminal States have no outgoing `flows_to` — they end the process path.",
        predicate: {
          kind: "flow-wiring",
          edge_type: "flows_to",
          initial_when: { field: "kind", equals: "initial" },
          terminal_when: { field: "kind", equals: "terminal" },
          // A process container Action (with `has_parent` children) is a pool,
          // not a sequenced step — it carries no `flows_to` and is exempt.
          exempt_when_incoming_edge_type: "has_parent",
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // State summary as milestone/condition — noun or past-participle
        // naming the milestone.
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `state`. PASS when the text reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`, `awaiting-review`). FAIL with reason if it reads as an imperative verb naming an Action (`Approve invoice`, `Process the order`).",
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Coverage ────────────────────────────────────────────────
      {
        // Every actor Principal earns its swim lane by being the target of ≥1
        // Action's `attributed_to` edge (an incoming performer link). A `warn`.
        // The process owner is covered too: a process is an Action, so the
        // `attributed_to` edge naming its owner is itself "an Action's
        // attributed_to edge" — no special exemption is needed anymore.
        on_violation: "warn",
        policy:
          "Each actor Principal in the process is the target of at least one Action's `attributed_to` edge — either as a step's performer or as a process Action's accountable owner.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          direction: "incoming",
          target_node_type: "action",
          when_node_type: ["principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Eval ────────────────────────────────────────────────────
      {
        policy:
          "Every Eval in process links to the node whose claim it pins with a `supports` edge to that node.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "Model a repeatable business process that produces a business outcome — not a UI journey, a code path, an incident, or a pure state machine. UI journeys and pure state machines belong in their own Docos.",
      },
      {
        policy:
          "Split a large process into nested subprocesses on a durable ownership boundary, for reuse across multiple parents, or for pure readability. A subprocess is just a member Action that has its own `has_parent` children.",
      },
      {
        policy:
          "When a step is itself a whole subprocess, give that step Action its own member flow nodes via `has_parent` edges instead of inlining dozens of Actions in the parent. The BPMN view renders the step collapsed (with a 'View subprocess' affordance) in the parent's pool and expands it into its own pool on demand, keeping the parent process readable.",
      },
      {
        policy:
          "Name the accountable process owner by attributing the process Action to a Principal — an `attributed_to` edge from the process Action to the one answerable for the whole process's outcome (the RACI 'Accountable' party), distinct from the per-step 'Responsible' performers, each named by an `attributed_to` edge from their step Action.",
      },
      {
        policy:
          "Agents should read `GET /<handle>/api/authoring-contract.json` and write structured flows with `POST /<handle>/api/changesets.json`; create flow nodes and their relationship edges in the same changeset, using the contract's edge types instead of disconnected nodes or ad hoc relationship names.",
      },
      {
        policy:
          "Use `relate_many` for sibling edges that must be valid together, especially exhaustive gateway branches. Adding one branch at a time can create a temporarily invalid BPMN graph.",
      },
      {
        policy:
          "BPMN vocabulary — an edge's meaning comes from its type plus the node types it connects, not from any role tag: `flows_to` is process order and renders source -> target with no reversal; a `has_parent` edge from a flow node to a process Action places it in that process's pool (and makes the parent Action a process, or a subprocess if it has a parent of its own); an `attributed_to` edge to a Principal drives actor lanes (from an Action), gateway deciders (from a Decision), and process ownership (from the process Action); a `constrained_by` edge to a Rule links a policy guard; a `supports` edge from an Eval tests the node it points at, and `supports` edges from other nodes carry rationale and evidence.",
      },
      {
        policy:
          "`flows_to` edges may carry props like `{ label, condition, kind }`. Put gateway branch labels and default/exception/timer metadata on the outgoing edge, not by reversing a relationship from the downstream Action back to the Decision.",
      },
      {
        policy:
          "For parallel work, give one flow node multiple unconditional `flows_to` outgoing edges — an AND-split needs no gateway Decision. Reserve gateway Decisions for exclusive or conditional (XOR/inclusive) branching, and reconverge parallel branches on a shared downstream node.",
      },
      {
        policy:
          "Rework and retry loops are allowed: a `flows_to` edge may target an earlier flow node to send work back (revise-and-resubmit, fix-and-recheck). Route the loop back through a gateway Decision so the cycle has an explicit exit and can't spin forever. A single edge still renders source -> target — a loop is about where the edge points, not reversing its direction.",
      },
      {
        policy:
          'Model the unhappy path. Use `flows_to` edge props with `kind: "exception"` or `kind: "timer"` to route failures, rejections, and timeouts to a recovery step or an explicitly cancelled terminal State, so the process documents what happens when the happy path does not hold.',
      },
      {
        policy:
          "Relationships in a process Doco are first-class edges with lifecycle and history. Use `flows_to` for process order and the canonical families (`supports`, `attributed_to`, `constrained_by`, `has_parent`, `derived_from`, `replaces`, `relates_to`); an edge's specialized meaning comes from its type plus the node types it connects, not from a role tag. Re-point by retiring the old edge and adding the new one; endpoints are immutable.",
      },
      {
        policy:
          "Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — its `has_parent` process membership, naming the actor or decider Principal (an Action's or gateway Decision's `attributed_to` edge to a Principal), forward `flows_to` wiring, gateway exhaustiveness, milestone naming, and quality are all suspended, so a step can be drafted before its actor, decider, or parent process (and BPMN pool) is chosen. `queue` it (changeset op `queue`) once it has a parent process and its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).",
      },
      {
        policy:
          "Use `queued` for a process — or a single step, gateway, or milestone — that is fully wired and ready but not yet in force: a redesign awaiting sign-off, a step pending a scheduled go-live, or an approved-but-not-yet-rolled-out change. A `queued` node asserts readiness, so it must already satisfy the same actor attribution, `has_parent` process membership, and forward-flow wiring an `active` node does. If it is still being sketched and that wiring is incomplete, leave it `drafting` instead of queuing it.",
      },
      {
        policy:
          "Process *instances* (recorded runs) live in a separate Doco as Logs; surface them here only via References. This template describes the design of the process, not the history of its executions.",
      },
      {
        policy:
          "Rules in a process Doco are process policies and guards (`refunds above $5k require manager approval`). Template-authoring rules — meta-rules about how to write process Docos — belong in the template or in `global`, not in any process using it.",
      },
      {
        policy:
          "Don't model every click, method call, or DB mutation — only the steps that mean something to a business operator. Implementation detail belongs in `apis` or code Docos, not here.",
      },
    ],
  },
  {
    // GitHub pull-requests template. PRs from a connected repository are
    // synced as Reference nodes. No authoring constraints are imposed —
    // the template is intentionally minimal; the GitHub integration
    // (configured immediately after Doco creation) handles the sync logic.
    name: "github-pull-requests",
    label: "GitHub pull requests",
    icon: "🐙",
    description:
      "Track a GitHub repository's pull requests as References — new PRs sync automatically, and merged PRs settle as active.",
    policies: [],
    // Default the overview to the Pull requests perspective (seeded by
    // migration 076). Resolved by slug at apply time; silently skipped if the
    // builtin row isn't present.
    perspectives: [{ slug: "pull-requests", isDefault: true }],
  },
  {
    // Organizational chart template. Principals are the org *seats*
    // (a role plus its current occupant), has_parent/reporting edges form the
    // primary hierarchy, Intents represent teams/units, Decisions
    // record reorgs and appointments. After the Principal slim-down
    // (decision_01KSDR_PRINCIPAL_SLIM_DOWN) a Principal carries a structured
    // `kind` ("human" | "agent") promoted to its own column. A FILLED seat
    // declares its occupant kind in that field — the org-tree perspective
    // prefers it (mapPrincipalKind), falling back to prose only when unset. A
    // VACANT seat carries NO `kind` (a budgeted-but-unfilled role stays on the
    // chart per HR practice) and states its vacancy in its `prose` (a
    // principal's one text home — no separate body). So the person / AI-agent /
    // vacant distinction is keyed off `kind` for the filled cases and off
    // `prose` for vacant, enforced by the probabilistic policy below.
    //
    // Reporting is a first-class edge: a `has_parent` edge between two
    // principals is a (solid-line) reporting line. The org tree renders
    // directly from edge rows. Dotted-line/matrix reporting and one-person-
    // multiple-seats (the former `same_occupant_as`) are no longer modeled.
    //
    // Industry alignment (W3C Organization Ontology + HR practice):
    // a seat that can stand vacant approximates `org:Post`. A fully
    // structural Post / Membership split — occupant nodes distinct from the seat, a versioned
    // `member_of` / `held_by` edge, a real vacancy field instead of a
    // `prose` declaration — remains a deliberate follow-up rather than
    // half-modeled here.
    name: "org-chart",
    label: "org-chart",
    icon: "🏢",
    description:
      "Map the people and AI agents in an organization — reporting lines, teams, roles, and appointments. Every filled seat sets its `kind` field to declare a person (`human`) or an AI agent (`agent`); a vacant seat sets no `kind` and says so in its `prose`.",
    // No `defaultNodeLifecycle` override: a seat, team, or appointment
    // is live the moment it's created, so a captured node lands
    // `active` (and the completeness rules — e.g. a team Intent's
    // roster, a seat's reporting line — apply right away). Two explicit
    // overrides cover the rest of the four-stage lifecycle: capture a
    // committed-but-not-yet-effective change (a signed hire, an
    // announced reorg) as `queued` — it meets the same completeness bar
    // as active but isn't in force yet — and sketch a tentative seat or
    // roster-less team as `drafting`, where the occupant or reporting
    // line may still be unknown. (Process keeps a `drafting`
    // default so a flow can be wired up incrementally.)
    perspectives: [{ slug: "org-tree", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Deterministic node-type allowlist. Org charts are made of
        // Principals (members), Intents (teams/units), Decisions
        // (appointments / reorgs), References (external org diagrams,
        // headcount budgets), and Rules (delegation policies).
        // Actions, States, Evals, Logs, and Ideas have their own
        // homes; an org chart describes who reports to whom, not
        // what they do. Policy records are Doco-scoped metadata and
        // bypass template membership gates in the authoring evaluator.
        policy:
          "Only Principal, Intent, Decision, Reference, and Rule belong as org-chart nodes. Actions describe activities (use process); States describe stages; Evals describe checks; Logs describe events; Ideas live in their own home.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["principal", "intent", "decision", "reference", "rule"],
        },
      },
      {
        // Edge-type allowlist. An org chart wires reporting lines (`has_parent`
        // between principals), team membership and accountability
        // (`attributed_to`), associative links (`relates_to`), reorg/appointment
        // rationale (`supports`), supersession (`replaces`), and provenance
        // (`derived_from`). BPMN sequence flow (`flows_to`) and Rule guards
        // (`constrained_by`) have no org-chart meaning, so they are barred.
        policy:
          "Only these relationship edge types may be used in an org-chart Doco: `has_parent`, `attributed_to`, `relates_to`, `supports`, `replaces`, `derived_from`. Process flow (`flows_to`) and Rule guards (`constrained_by`) belong in other Doco kinds.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "has_parent",
            "attributed_to",
            "relates_to",
            "supports",
            "replaces",
            "derived_from",
          ],
        },
      },

      // ── The unique bit — every member declares person or AI agent ──
      {
        // THE DISTINGUISHING CONSTRAINT. The Principal slim-down promoted a
        // structured `kind` ("human" | "agent") onto the Principal, so a FILLED
        // seat declares its occupant kind in that field. Org charts still need
        // the declaration on every seat, so this probabilistic policy reads
        // `kind` first and blocks captures that leave the distinction ambiguous.
        // A third state — `vacant` — lets a budgeted-but-unfilled seat live on
        // the chart (HR best practice: omitting open roles breaks headcount and
        // reporting structure); a vacant seat carries NO `kind`, so its vacancy
        // is read from its `prose` (a principal's one text home — there is no
        // separate body). A vacant seat is the closest this template gets to W3C
        // `org:Post` without a schema change.
        predicate: {
          kind: "probabilistic",
          when_node_type: ["principal"],
          spec: "Read the Principal's `kind` field and its `prose`. PASS if `kind` is `human` (the seat is filled by a person) or `agent` (filled by an AI agent), OR if `kind` is unset AND the `prose` states the seat is currently vacant/open (e.g. 'Vacant — budgeted Staff Engineer seat, reporting to …'). FAIL with a reason if `kind` is unset AND the prose does not declare the seat vacant — the seat must state whether it's filled by a person, filled by an AI agent, or vacant.",
        },
      },

      // ── Hierarchy: every Principal either reports up or explains root ──
      {
        // A `has_parent` edge from this principal to its manager principal
        // forms the org tree. This uses a single probabilistic warning rather
        // than a deterministic `requires_edge` predicate because a
        // valid root Principal (CEO/founder/root agent/external
        // authority) should not receive an unavoidable "missing
        // reporting edge" warning once its prose explains the absence.
        //
        // Fires on `queued` AND `active`: a queued seat is a committed,
        // ready-to-go-live org fact (a signed hire, an announced
        // appointment) — as complete as an in-force one, so its reporting
        // line should already be wired. Only `drafting` — the
        // still-being-sketched stage — is exempt, so a member can be
        // captured before its manager exists.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["principal"],
          spec: "Read the Principal candidate. PASS if its prose explains why this Principal has no manager above it (founder, board-reporting, root agent, external authority, etc.). Otherwise, expect a `has_parent` edge from this Principal to its manager Principal in the graph; if it is absent, WARN that the reporting edge is missing.",
        },
        fires_when_node_lifecycle: ["queued", "active"],
      },

      // ── Team Intents declare members ───────────────────────────
      {
        // Formerly a `descriptive` predicate (recorded, never enforced); now a
        // deterministic `warn`. A committed team/unit Intent links to its
        // member Principals with outgoing `attributed_to` edges — an
        // `attributed_to` edge from a team Intent to a Principal IS a
        // membership link. `warn`, not block: a team that's `queued` to stand
        // up should already name its roster, but a roster wired one member at a
        // time shouldn't hard-fail mid-edit, and a `drafting` team is exempt
        // entirely.
        on_violation: "warn",
        policy:
          "Every in-force or queued team/unit Intent in an org chart is linked to its member Principals with `attributed_to` edges from the Intent to each Principal. A team with no members usually means a roster that has not been wired yet.",
        predicate: {
          // No `target_node_type` needed — the relation catalog already pins
          // `attributed_to`'s target to a Principal, so any such edge from a
          // team Intent is a member link.
          kind: "requires_edge",
          edge_type: "attributed_to",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["queued", "active"],
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "An org chart describes who reports to whom and which teams exist — not what those people do. Activities, processes, and workflows belong in process Docos linked via Reference.",
      },
      {
        // The `queued` lifecycle stage is org charting's "future-effective"
        // tool: it lets the chart hold a committed change before its
        // effective date without pretending it's already in force. This is
        // the org-chart analogue of the canonical `queued` example (an open
        // PR that's ready but not yet merged).
        policy:
          "Stage a future-effective org change as `queued`: a signed hire who hasn't started, an announced promotion or appointment with a later effective date, a decided-but-unexecuted reorg, or a named successor. A queued seat or reporting line is fully specified — occupant declared, reporting edge wired — it just isn't in force yet, so it shows as pending on the chart. Activate it (the `activate` op) on the effective date. Reserve `drafting` for an org change you're still sketching, where the occupant or reporting line may still be unknown; retire a seat or line that's been vacated or rerouted.",
      },
      {
        policy:
          "Reporting chains must not be circular. A cycle (A reports to B, B reports to C, C reports to A) usually means a refactor in progress; resolve it before activating the affected Principals. The framework evaluator can't check this yet — it's a manual review.",
      },
      {
        policy:
          "AI-agent Principals that act on a human's behalf should declare that human in their `prose` (`Operates under: @alice`), or via a `delegated_by` Decision linking the human Principal to the agent Principal. Autonomous agents (no human owner) state that explicitly so readers know the accountability stops at the agent.",
      },
      {
        policy:
          "Capture reorgs, hires, departures, and role changes as Decisions, and link the affected Principals with `supports` or provenance edges. Org charts churn; without Decisions, the history of WHY a reporting line moved is lost. When the change is decided but takes effect later, `queue` the Decision (and the seats and reporting edges it moves) and `activate` them on the effective date.",
      },
      {
        policy:
          "Team membership lives in edges. When someone joins or leaves a team, retire the old membership edge or add a new one, and record a Decision so the why and when survive the change.",
      },
      {
        policy:
          "A reporting line is a first-class `has_parent` edge from a principal to its manager principal. Re-point it by retiring the old edge and adding the new one, and capture the why of the reorg as a Decision so the rationale survives the edit.",
      },
      {
        policy:
          "Each seat reports to exactly one manager — a single `has_parent` edge to its manager principal (the solid-line reporting relationship) — so the org tree stays a clean hierarchy. Dotted-line and matrix reporting are not modeled: don't give a seat a second manager edge.",
      },
      {
        policy:
          "Each seat is one Principal. One person holding several seats (the CEO who also acts as VP Eng, a founder covering two roles) is not modeled: model each seat as its own Principal, and don't collapse two distinct roles into one Principal just because the same person fills them today.",
      },
      {
        policy:
          "Use Intents to model teams, departments, and org units. The Intent's `intent` field names the unit's mandate; membership and stakeholder relationships are edges to Principal nodes.",
      },
      {
        policy:
          "Model load-bearing roles and recurring positions — not every contractor, intern, or one-day visitor. If a seat would be empty in three months, it probably belongs in a sibling Doco or a Reference rather than as a Principal here.",
      },
      {
        policy:
          "Treat each Principal as a seat — a role plus its current occupant — not just a person. A filled seat sets `kind` to `human` or `agent`; a budgeted-but-unfilled seat is still a valid Principal: leave `kind` unset, declare it `vacant` in its `prose`, name the role it's budgeted for, and keep its reporting edge so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure.",
      },
      {
        policy:
          "Person vs agent isn't about who signed in — it's about who fills the seat, declared in the `kind` field. A Principal with `kind: agent` (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal with `kind: human` is a person, even if that human has no Doco account. A vacant seat sets no `kind` and says so in its `prose`.",
      },
      {
        policy:
          "Seats persist across routine turnover: when one person leaves and another fills the same seat — or a seat goes vacant and is later refilled by the same kind of occupant — keep the Principal, update its `prose` (and clear or restore `kind` as the seat empties or refills), and record the change as a Decision, so reporting and membership edges stay intact and the seat's history reads continuously. Only when the seat's nature flips between person (`kind: human`) and AI agent (`kind: agent`) do you retire the old Principal and create a new one.",
      },
      {
        // Mirrors the process authoring rule. Org charts are
        // frequently bulk-imported or backfilled by agents (from an HRIS, a
        // Slack roster, a headcount sheet), so the changeset batch — create a
        // seat and wire its reporting edge atomically — is exactly right.
        // This also re-points agents at the CURRENT changeset ops after the
        // `assert`→`activate` rename and the new `queue` op.
        policy:
          "Agents author org changes through `GET /<handle>/api/authoring-contract.json` and `POST /<handle>/api/changesets.json`: create a seat and its `has_parent` reporting edge in one changeset so the tree is never transiently rootless, and use `relate_many` for sibling edges that must hold together — e.g. a team Intent's `attributed_to` member edges added as one batch. Stage a future-effective change with the `queue` op and put it in force with `activate`.",
      },
    ],
  },
];

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored under plain handles (`architectural-decisions`,
 * `product-decisions`, `design-decisions`, `data-decisions`, `glossaries`,
 * `process`, `github-pull-requests`, `org-chart`).
 */
export function findDocoTemplateByName(name: string): DocoTemplate | undefined {
  return DEFAULT_DOCO_TEMPLATES.find((t) => t.name === name);
}

/**
 * The essence of a seeded policy row — a standalone `kind` plus the
 * predicate the evaluator dispatches on. This is the pure translation
 * from the (still old-shape) `TemplatePolicy` into the unified policies
 * table introduced in #909; `host.ts` wraps it with the DB-row metadata
 * (ids, timestamps, `template_seeded`) at Doco-creation time.
 */
export interface SeededPolicyRow {
  kind: "suggestion" | "deterministic" | "probabilistic";
  /**
   * suggestion / probabilistic → `{ agent_instruction, when_node_type? }`
   * deterministic              → `{ sub_kind, ...check params }`
   */
  predicate: Record<string, unknown>;
  /** Set for deterministic / probabilistic policies (defaults to "block"); omitted for suggestions. */
  on_violation?: "block" | "warn" | "log";
  fires_when_node_lifecycle?: Lifecycle[];
}

/**
 * Translate one `TemplatePolicy` into the unified policy row the evaluator
 * consumes. Split purely by predicate shape:
 *   - no predicate                    → `suggestion` (the prose is the instruction)
 *   - `probabilistic`                 → `probabilistic` (LLM-judged at write time)
 *   - `descriptive`                   → `suggestion` (recorded, not enforced)
 *   - any other (structured) predicate → `deterministic`, keyed by `sub_kind`
 *
 * Shared by `host.ts` (which seeds these rows) and the template scenario
 * tests (which run them through the real evaluator), so the two can never
 * drift apart.
 */
export function templatePolicyToPolicyRow(policy: TemplatePolicy): SeededPolicyRow {
  const pred = policy.predicate;
  let kind: SeededPolicyRow["kind"];
  let predicate: Record<string, unknown>;
  if (!pred) {
    kind = "suggestion";
    predicate = { agent_instruction: policy.policy ?? "" };
  } else if (pred.kind === "probabilistic" || pred.kind === "descriptive") {
    // `descriptive` was recorded-but-not-enforced → folds into suggestion.
    kind = pred.kind === "probabilistic" ? "probabilistic" : "suggestion";
    predicate = {
      agent_instruction: pred.spec,
      ...(pred.when_node_type ? { when_node_type: pred.when_node_type } : {}),
    };
  } else if (pred.kind === "edge-probabilistic") {
    // Edge-scoped probabilistic: LLM-judged like `probabilistic`, but fires on
    // edge creation with both endpoints handed to the judge. The edge scoping
    // (edge_type / endpoint node types) rides on the seeded predicate.
    kind = "probabilistic";
    predicate = {
      agent_instruction: pred.spec,
      edge_type: pred.edge_type,
      ...(pred.from_node_type ? { from_node_type: pred.from_node_type } : {}),
      ...(pred.to_node_type ? { to_node_type: pred.to_node_type } : {}),
    };
  } else {
    kind = "deterministic";
    const { kind: subKind, ...rest } = pred;
    predicate = { sub_kind: subKind, ...rest };
  }
  const firesWhen = Array.isArray(policy.fires_when_node_lifecycle)
    ? policy.fires_when_node_lifecycle
    : [];
  return {
    kind,
    predicate,
    ...(kind !== "suggestion" ? { on_violation: policy.on_violation ?? "block" } : {}),
    ...(firesWhen.length > 0 ? { fires_when_node_lifecycle: firesWhen } : {}),
  };
}
