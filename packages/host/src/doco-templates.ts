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
  /** The one-line statement of the policy. For a prose-only entry this IS
   *  the policy — it seeds the `suggestion`'s agent instruction. For a
   *  `probabilistic` entry the `predicate.spec` is what the judge and
   *  agents actually see, so this doubles as the in-code summary. For a
   *  `deterministic` entry it is human-readable documentation of the
   *  structured check. */
  policy: string;
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
   * business-processes template ships `[{slug:"bpmn"}]` so a Doco
   * created from that template arrives with the BPMN tab ready.
   */
  perspectives?: TemplatePerspectiveAttachment[];
  /**
   * When set, captures into a Doco created from this template default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The business-processes template
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
  decisionMembershipPolicy: string;
  decisionMembershipSpec: string;
  qualityPolicy: string;
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
    "Check the Decision's `decision`, `question`, `chosen`, and `alternatives`.",
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
      policy: opts.decisionMembershipPolicy,
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
      policy: opts.qualityPolicy,
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
 * Business-processes fires its completeness + shape policies on the two
 * *committed* lifecycle stages — `queued` (ready, awaiting activation) and
 * `active` (in force) — and exempts only `drafting`.
 *
 * Rationale (the `queued` stage): the node lifecycle is now
 * `drafting → queued → active → retired`. A node an author has explicitly
 * `queue`d is asserting it is ready to go live, so it must already satisfy
 * the same actor (`performed_by`), Intent (`serves`), and forward
 * `flows_to` wiring an `active` node does — otherwise "ready" is a lie the
 * BPMN renderer can't draw. Only a `drafting` sketch may be incomplete.
 *
 * This is scoped to business-processes on purpose: it is the one template
 * that defaults new nodes to `drafting` and carries a real
 * draft → queue → activate authoring story. Templates that default new
 * nodes straight to `active` (decision-records, glossaries, org-chart)
 * rarely pass through `queued`, so they still fire on `["active"]`.
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
      decisionMembershipPolicy:
        "A Decision belongs in architectural-decisions when it records an architectural decision: system structure, API or integration boundaries, infrastructure, quality attributes, operational constraints, security/compliance architecture, implementation evidence, or an architecture validation check.",
      decisionMembershipSpec:
        "PASS for ADR Decisions, technology-selection Decisions, and security/privacy architecture Decisions that record system structure, API or integration boundaries, infrastructure, quality attributes, operational constraints, compliance architecture, implementation evidence, or architecture validation, including Decisions supported by References and Evals. FAIL for product roadmap or pricing choices (route to product-decisions), UI or interaction design choices (design-decisions), data-definition or governance decisions (data-decisions), raw incidents, or implementation tasks with no architectural consequence.",
      qualityPolicy:
        "An active architectural Decision reads like an ADR: it states context and problem, decision drivers or quality attributes, options considered, chosen approach, consequences and trade-offs, implementation/migration impact, and the review or rollback trigger.",
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
        "Architecture records link the accountable technical owner or review group with an `attributed_to` edge carrying role `decided_by`, or name it in prose if no Principal node exists yet, and call out product, design, data, security, or operations stakeholders when the decision crosses those boundaries.",
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
      decisionMembershipPolicy:
        "A Decision belongs in product-decisions when it records a product decision: target users, problem framing, scope, roadmap priority, launch strategy, pricing/packaging, growth motion, success metrics, experiment interpretation, or a deliberate decision not to build something.",
      decisionMembershipSpec:
        "PASS for product Decisions about target users, product goals or outcomes, product principles or commitments, customer/research evidence, experiment or metric interpretation, pricing, packaging, roadmap priority, launch strategy, or deliberate decisions not to build something, including Decisions supported by References and Evals. FAIL for engineering or infrastructure implementation choices (route to architectural-decisions), visual or interaction design details (design-decisions), data-governance or metric-definition choices (data-decisions), one-off support events, or unpromoted feature ideas with no decision yet.",
      qualityPolicy:
        "An active product Decision states the user/customer problem, strategic goal, evidence, assumptions, options considered, chosen product direction, explicit trade-offs, success metric, accountable decision role, and revisit trigger.",
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
      decisionMembershipPolicy:
        "A Decision belongs in design-decisions when it records a design decision: user journeys, interaction patterns, service flows, content strategy, accessibility behavior, design-system conventions, visual hierarchy with product meaning, research findings, prototypes, or usability validation.",
      decisionMembershipSpec:
        "PASS for design Decisions about user journeys, interaction patterns, service flows, content strategy, accessibility behavior, design-system conventions, visual hierarchy with product meaning, research findings, prototypes, or usability validation, including Decisions supported by Figma or research References and usability/accessibility Evals. FAIL for backend or infrastructure architecture (route to architectural-decisions), product scope or roadmap priority without UX implications (product-decisions), data governance or schema decisions (data-decisions), or cosmetic preference notes with no user or system rationale.",
      qualityPolicy:
        "An active design Decision states the user journey or service moment, evidence, alternatives considered, chosen pattern, affected states and edge cases, accessibility/content implications, trade-offs, artifacts, and validation plan.",
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
      decisionMembershipPolicy:
        "A Decision belongs in data-decisions when it records a data decision: source-of-truth ownership, canonical metric or entity definitions, schema and contract choices, lineage, quality/freshness targets, retention, privacy classification, access controls, migration/backfill plans, or consumer-impact validation.",
      decisionMembershipSpec:
        "PASS for data Decisions about source-of-truth ownership, canonical metric or entity definitions, schema and contract choices, lineage, quality/freshness targets, retention, privacy classification, access controls, migration/backfill plans, or consumer-impact validation, including Decisions supported by data contract References and quality or freshness Evals. FAIL for UI or interaction design decisions (route to design-decisions), product roadmap or pricing choices (product-decisions), pure application or infrastructure architecture with no data ownership or semantics impact (architectural-decisions), or raw pipeline run Logs.",
      qualityPolicy:
        "An active data Decision states the data asset or definition, accountable owner/steward, producers and consumers, source of truth, schema or semantics, privacy/access/retention stance, quality and freshness expectations, lineage, migration/backfill impact, and monitoring/revisit plan.",
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
    // Decision: `question` names the concept, `chosen` is the canonical
    // headword, `decision` holds the definition, scope, and examples, and
    // `alternatives` carries aliases / rejected labels.
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
    // business-processes, which defaults to `drafting` so a flow can be
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
        policy:
          "A node belongs in glossaries when it defines product or domain terminology, records a terminology choice, cites an authoritative source, states a terminology usage rule, or checks terminology consistency. Feature work, process flows, org charts, and runtime events belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in glossaries when it defines product or domain terminology, records a terminology choice, cites an authoritative source, states a terminology usage rule, or checks terminology consistency. PASS for term entries, terminology usage rules, references to source glossaries/specs/docs, and evals that scan terminology consistency. FAIL for glossary scope statements, feature implementation work, process flows, org charts, runtime incidents, or state-machine stages.",
          when_node_type: ["decision", "rule", "reference", "eval"],
        },
      },
      {
        policy:
          "Only Decision, Rule, Reference, and Eval are glossary graph nodes. Intents, Actions, Logs, States, Ideas, and Principals have their own homes.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["decision", "rule", "reference", "eval"],
        },
      },

      // ── Term entry Decisions ───────────────────────────────────
      {
        policy:
          "Every active glossary Decision declares `question` and `chosen`: the concept question and the canonical term.",
        predicate: {
          kind: "requires_field",
          fields: ["question", "chosen"],
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: ["active"],
      },
      {
        // Warn, not block: a clashing `chosen` is usually a duplicate
        // entry, but genuine homographs (distinct concepts sharing a
        // surface form) are legitimate terminology. Surface the clash so
        // the author either merges the duplicate or disambiguates the
        // homograph with a qualifier — don't hard-block the correct
        // modeling choice. See the homograph guidance below.
        on_violation: "warn",
        policy:
          "Active glossary Decisions should have a unique canonical term in `chosen`, compared case-insensitively. A clash is usually a duplicate entry to merge; genuine homographs (distinct concepts sharing a surface form) are allowed when disambiguated with a qualifier.",
        predicate: {
          kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: ["active"],
      },
      {
        // One combined quality judge for term-entry Decisions. This used to
        // be three separate probabilistic policies (one-concept, definition
        // completeness, acronym expansion); stress-testing showed three
        // problems they now fix together: (1) they BLOCKED by default, so a
        // single judge misfire lost the author's work — a quality nudge, not
        // an integrity constraint, so it now WARNs; (2) the acronym check
        // fired on any incidental abbreviation in prose (`rep`, `WIP`), so it
        // is now scoped to the headword in `chosen`; (3) one combined judge
        // call replaces three, cutting latency and the misfire surface.
        on_violation: "warn",
        policy:
          "A glossary term-entry Decision defines exactly one concept with a usable definition. It keeps one concept per entry, its `decision` prose gives a concise definition plus the product/domain scope and at least one example or non-example (never a circular restatement of the headword), and — when the canonical term in `chosen` is itself an acronym or abbreviation — spells out the expanded form and says when the short form is acceptable.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "Judge a glossary term-entry Decision on three aspects; report each failing aspect with a reason, but treat them as warnings, not hard errors. (a) ONE CONCEPT: PASS when the entry defines one concept or one canonical term; FAIL when it defines multiple independent terms, bundles a term with an unrelated policy, or is a catch-all for several concepts. (b) USABLE DEFINITION: PASS when the `decision` prose gives a concise definition AND the product or domain scope where the term applies AND at least one concrete example OR non-example — EITHER an example or a non-example is sufficient, do not require both; FAIL when one of those three is genuinely absent, or when the prose merely restates the headword instead of explaining it (a circular definition such as `a workspace is a workspace`). (c) ACRONYMS AND ABBREVIATIONS: only inspect the canonical term in `chosen`. If `chosen` is itself an acronym or abbreviation, PASS when the prose expands it at least once and states whether the short form is acceptable in product/docs/UI copy; FAIL when it is left unexpanded. Incidental abbreviations that merely appear in the prose (not the headword) are OUT OF SCOPE — ignore them. If `chosen` is not an acronym, this aspect PASSES.",
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
        policy:
          "An active glossary Eval's `how_to_run` names a concrete command, query, URL, or review procedure plus any scope needed to reproduce the terminology check.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["eval"],
          spec: "Check the Eval's `how_to_run` field. PASS when it gives a concrete rerun path: an exact command, search query, URL, script, or manual review procedure, plus the doc/code/product scope to inspect. FAIL when it is vague (`review docs`, `check terminology`) or depends on unstated context.",
        },
        fires_when_node_lifecycle: ["active"],
      },

      // ── Guidance ───────────────────────────────────────────────
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
          "When two distinct concepts share a surface form (homographs, e.g. `Order` in commerce vs. `Order` as a sort operation), give each its own Decision and disambiguate `chosen` with a qualifier — `Order (commerce)` vs. `Order (sorting)` — so every entry stays uniquely addressable.",
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
          "Retired glossary Decisions point at the replacement term with a `replaces` edge when an old term appears in historical docs, UI, tickets, APIs, or code. Keep the deprecated term visible so readers still understand old references. Re-point by retiring the old edge and adding a new one.",
      },
      {
        policy:
          "Use Rules for terminology usage policies, such as banned words, capitalization conventions, UI copy constraints, or when two related terms must not be used interchangeably.",
      },
      {
        policy:
          "Agents read `GET /<handle>/api/authoring-contract.json` for the live field and edge vocabulary, then write terms with `POST /<handle>/api/changesets.json` — creating the term Decision together with its `relates_to`, `derived_from`, or `replaces` edges in the same changeset so an entry never lands isolated.",
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
    // freely; completeness + shape rules fire on the committed stages
    // (`queued` and `active`) only — see BUSINESS_PROCESS_COMMITTED_LIFECYCLES.
    name: "business-processes",
    label: "business-processes",
    icon: "🏭",
    description:
      "Document repeatable business processes — the flow of work through actors, gateways, and milestones to a business outcome. Inspired by BPMN swimlanes and gateways.",
    defaultNodeLifecycle: "drafting",
    // Ship the BPMN perspective pre-attached and as the default tab,
    // so a freshly-created business-processes Doco opens directly on
    // the swim-lane view (where the template's authoring rules are
    // most naturally visible). Graph + list defaults are still
    // attached behind it.
    perspectives: [{ slug: "bpmn", isDefault: true }],
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
        policy:
          "A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. One-off incidents, UI-specific user journeys, and pure state machines without a workflow outcome belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. Pass when the candidate describes a step, gateway, milestone, validation, reference, or policy for such a workflow. Fail only when the candidate is a one-off incident with no repeatable structure, a UI-specific user journey, or a pure state machine without a workflow outcome.",
          when_node_type: ["intent", "action", "decision", "eval", "reference"],
        },
      },
      {
        // Deterministic node-type allowlist. Logs (recorded executions)
        // live in a sibling Doco and are surfaced here via Reference;
        // Ideas live in their own home until promoted. Policy records are
        // Doco-scoped metadata and bypass template membership gates in the
        // authoring evaluator.
        policy:
          "Only Intent, Action, Decision, State, Eval, Reference, Rule, and Principal belong here. Logs (recorded executions) live in a sibling Doco and are referenced from here; Ideas live in their own home until promoted.",
        predicate: {
          kind: "requires_node_type",
          node_types: [
            "intent",
            "action",
            "decision",
            "state",
            "eval",
            "reference",
            "rule",
            "principal",
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
          "Business-process prose must not contain raw BPMN/import scaffolding tokens — camelCase BPMN element types or generated element ids leaked from an importer.",
        predicate: {
          kind: "forbids_field_pattern",
          fields: [
            "intent",
            "action",
            "decision",
            "question",
            "chosen",
            "state",
            "rule",
            "eval",
            "name",
            "body_md",
          ],
          pattern:
            "(exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway|(?:Gateway|Task|UserTask|ServiceTask|SequenceFlow|StartEvent|EndEvent|BoundaryEvent|SubProcess|DataObject)_[A-Za-z0-9]+|user asks:)",
          flags: "i",
          when_node_type: ["intent", "action", "decision", "state", "eval", "rule", "principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Import provenance belongs in structured metadata, References,
        // or history, not in the labels/prose that BPMN readers scan.
        // This stays LLM-judged because terms like "source" and
        // "implementation" can be legitimate business language; the bad
        // case is raw importer/debug scaffolding leaking into process text.
        policy:
          "Business-process nodes must keep imported BPMN/source metadata out of user-facing prose.",
        on_violation: "block",
        predicate: {
          kind: "probabilistic",
          spec: 'Check the candidate\'s visible user-facing text fields, including name, body_md, intent, action, decision, question, chosen, state, rule, and eval text. PASS when the text reads as business-process language for an operator or process reader, and any BPMN/source/import/code-evidence details are absent from visible prose or kept only in structured metadata, References, or audit/history. FAIL when visible text contains raw import scaffolding or implementation/source metadata, including phrases or patterns like "BPMN gateway", "BPMN task", "Gateway_...", "Implementation status", "Code evidence", "Source type", "exclusiveGateway", "user asks:", raw BPMN ids, generated object ids, or notes about code evidence discovered during import. Do not fail merely because a real business term happens to mention a job type, gateway, source, or implementation in ordinary process language; fail only when the prose exposes importer/debug/source metadata instead of the process meaning.',
          when_node_type: ["intent", "action", "decision", "state", "eval", "rule", "principal"],
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
        policy:
          "Principals in business-processes are swim-lane actors: a role, team, external party, or system that owns work in the process. The Principal's `name` and `body_md` should make its process responsibility and boundary clear.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Principal's `name` and `body_md`. PASS when the Principal clearly names a process actor — a role, team, external party, or system — and the body explains what responsibility or boundary it owns in this process. FAIL if it reads like an uncontextualized org-chart person, a vague label (`user`, `team`, `system`) with no process responsibility, or an empty shell with no body prose.",
          when_node_type: ["principal"],
        },
      },

      // ── Intent shape ────────────────────────────────────────────
      {
        // Deterministic floor under the headline judge below: line one is the
        // label readers scan, so it must be short enough to BE a headline. A
        // run-on first line that crams the whole description into one sentence
        // trips this cheaply; whether the headline reads as a verb+object name
        // (and the body names trigger/outcome/scope) stays with the judge.
        // `warn`, not block — a slightly-long-but-legible headline shouldn't
        // trap the author.
        on_violation: "warn",
        policy:
          "The purpose Intent's first line is a brief headline, not a run-on sentence — keep it short enough to scan as a process name.",
        predicate: {
          kind: "field-line-shape",
          field: "intent",
          max_first_line_chars: 80,
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Probabilistic on intent — the FIRST LINE is a brief BPMN process
        // name (the label readers scan and the card summary takes from line
        // one). That is ALL this policy asks of the Intent. The body is free
        // prose; the template deliberately no longer requires the Intent to
        // restate the trigger, the terminal outcome, or what is out of scope —
        // those already live structurally as the process's initial State, its
        // terminal State, and the flow wiring between them, so duplicating
        // them in the Intent prose only bloated it.
        policy:
          "The purpose Intent of a business process opens with a brief BPMN-style name on its first line — a short verb-and-object phrase, optionally with an adjective or adverb (for example, `Publish a job`), not a run-on sentence.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the FIRST LINE of the Intent's `intent` field. PASS when the first line is a brief process name — a short verb + object phrase, optionally with an adjective or adverb, roughly two to six words (e.g. `Publish a job`), and NOT a full run-on sentence that buries the name. FAIL with `first line is not a brief headline` when line one crams a whole description into one sentence. Judge ONLY the first line; whatever follows it is free prose and is not graded.",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Action shape ────────────────────────────────────────────
      {
        policy:
          "Every Action in business-processes must have a `performed_by` relationship to the Principal who performs the activity (stored as an `attributed_to` edge).",
        predicate: {
          kind: "requires_edge_role",
          edge_type: "attributed_to",
          edge_role: "performed_by",
          target_node_type: "principal",
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // One rule for all three flow-node types. The role-aware edge
        // predicate filters by `when_node_type`, so a single policy covers
        // Action, gateway Decision, and milestone State — they share the
        // same constraint (be tied to a concrete process/pool) and
        // previously shipped as three near-identical entries.
        policy:
          "Every flow node in business-processes — Action, gateway Decision, or milestone State — must `serve` an Intent (stored as a `supports` edge with role `serves`). Without it the BPMN renderer can't place the node in a pool, and the step floats free of the business outcome it advances.",
        predicate: {
          kind: "requires_edge_role",
          edge_type: "supports",
          edge_role: "serves",
          target_node_type: "intent",
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
        policy:
          "Action `action` reads as an atomic business activity — a single unit of work an actor performs. Avoid vague umbrella phases (`handle request`, `do the thing`), steps that bundle two activities with `and`, and implementation chores divorced from business meaning (`call API`, `update row`).",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Action's `action` and `verb`. PASS when the text names a single business activity the named actor performs — an ordinary single-verb step like `review the legal terms`, `approve the invoice`, or `pack the order` PASSES. FAIL with reason only if the text (a) is a vague umbrella phase covering many steps (e.g. `handle request`, `do the thing`, `process order`), (b) bundles two distinct activities joined by `and` (e.g. `examine and treat the patient`), or (c) is an implementation chore divorced from business meaning (e.g. `call API`, `update row`, `write to DB`).",
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
        policy:
          "Gateway Decisions in business-processes have exhaustive outgoing branches. The `question` reads as yes/no or an enumerated choice, and the `alternatives` plus outgoing `flows_to` branch labels either include a default/else branch or name every enum value.",
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
        // We make that accountability explicit instead: every committed
        // gateway names the Principal — a role, team, or system actor —
        // answerable for the call, via a `decided_by` attributed_to edge.
        // Mirrors the Action `performed_by` gate and fires on the same
        // committed stages, so a gateway may be sketched unowned in
        // `drafting` but cannot be queued or activated without a decider
        // (which would also strand it in the BPMN "Unassigned" lane). The
        // perspective still renders a decider supplied via `performed_by`,
        // but `decided_by` is the role this template requires.
        policy:
          "Every gateway Decision in business-processes must have a `decided_by` relationship to the Principal answerable for the call — the role, team, or system that owns how the gateway is decided (stored as an `attributed_to` edge). A gateway with no decider floats into the Unassigned lane.",
        predicate: {
          kind: "requires_edge_role",
          edge_type: "attributed_to",
          edge_role: "decided_by",
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
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // State summary as milestone/condition — noun or past-participle
        // naming the milestone.
        policy:
          "State `state` reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`), not an imperative verb naming an Action (`Approve invoice`).",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `state`. PASS when the text reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`, `awaiting-review`). FAIL with reason if it reads as an imperative verb naming an Action (`Approve invoice`, `Process the order`).",
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Coverage ────────────────────────────────────────────────
      {
        // Every actor Principal earns its swim lane by owning ≥1 Action
        // (incoming `attributed_to` role `performed_by`). Deterministic, but a
        // `warn`: the single accountable owner (linked by `owned_by`) performs
        // no step yet is legitimately present, so it is structurally exempt —
        // the same "don't ding a valid special case" instinct behind the
        // org-tree root-Principal nudge. (That each Action `serves` the Intent
        // is already enforced by the flow-node `serves` gate above.)
        on_violation: "warn",
        policy:
          "Each actor Principal in the process owns at least one Action through a `performed_by` relationship. The single accountable process owner, linked by `owned_by`, is exempt.",
        predicate: {
          kind: "requires_edge_role",
          edge_type: "attributed_to",
          edge_role: "performed_by",
          direction: "incoming",
          exempt_when_role: "owned_by",
          when_node_type: ["principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // The accountable process owner — formerly prose-only guidance, now a
        // `warn` gate. A committed process Intent should name its owner via an
        // `attributed_to` edge with role `owned_by`. Kept as `warn` (not block)
        // because a sub-process child Intent may inherit ownership rather than
        // re-declare it, and we don't want to false-positive on those.
        on_violation: "warn",
        policy:
          "Name the single accountable process owner in the purpose Intent and link it with an `attributed_to` edge carrying role `owned_by` — the Principal answerable for the whole process's outcome (the RACI 'Accountable' role, distinct from the per-step `performed_by` actors).",
        predicate: {
          kind: "requires_edge_role",
          edge_type: "attributed_to",
          edge_role: "owned_by",
          target_node_type: "principal",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Eval ────────────────────────────────────────────────────
      {
        policy:
          "Every Eval in business-processes must `test` the node whose claim it pins (stored as a `supports` edge with role `tests`).",
        predicate: {
          kind: "requires_edge_role",
          edge_type: "supports",
          edge_role: "tests",
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
          "Use one linked Intent per concrete process when the Doco is large. Split on a durable ownership boundary, reuse across multiple parents, or pure readability.",
      },
      {
        policy:
          "When a step is itself a whole sub-process, model it as its own child process Intent and connect the calling Action with a `serves` relationship (stored as `supports` role `serves`) instead of inlining dozens of Actions. The BPMN view collapses the child Intent into its own pool, keeping the parent process readable.",
      },
      {
        // The naming convention that keeps an Action→Intent `serves` pairing
        // legible: the same activity is named once as work performed (the
        // Action, third-person — `Posts a job`) and once as the goal it serves
        // (the child purpose Intent, imperative base form — `Post a job`). This
        // is authoring guidance, not an enforced gate: the convention spans two
        // nodes (compare the child Intent's name against the calling Action's),
        // and the write-time judge only sees the single candidate's fields, so
        // it can't compare across the `serves` edge.
        policy:
          "Name a sub-process by pairing a calling Action with a child purpose Intent through a `serves` relationship, and derive the Intent's name from that Action: take the base form (the imperative) of the Action's verb, which is normally written third-person. For example, the Action `Posts a job` becomes the child Intent `Post a job`. The two read as the same activity — one as the work performed, one as the goal it serves.",
      },
      {
        policy:
          "Name the single accountable process owner in the purpose Intent and link it with an `attributed_to` edge carrying role `owned_by` — the Principal answerable for the whole process's outcome. This is the RACI 'Accountable' role, distinct from the per-step 'Responsible' actors linked by role `performed_by`.",
      },
      {
        policy:
          "Agents should read `GET /<handle>/api/authoring-contract.json` and write structured flows with `POST /<handle>/api/changesets.json`; create flow nodes and their relationship edges in the same changeset, using the contract's role examples instead of disconnected nodes or ad hoc relationship names.",
      },
      {
        policy:
          "Use `relate_many` for sibling edges that must be valid together, especially exhaustive gateway branches. Adding one branch at a time can create a temporarily invalid BPMN graph.",
      },
      {
        policy:
          "BPMN vocabulary: `flows_to` is process order and renders source -> target with no reversal; `serves` (stored as `supports`) places nodes in Intent pools; `performed_by`, `decided_by`, and `owned_by` (stored as `attributed_to`) drive actor lanes, gateway deciders, and process ownership; `gated_by` (stored as `constrained_by`) links policy guards; `tests`, `enacts`, and `implemented_by` use `supports` with role metadata for validation, rationale, and evidence.",
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
          "Relationships in a business-processes Doco are first-class edges with lifecycle and history. Use `flows_to` for process order and the canonical families (`supports`, `attributed_to`, `constrained_by`, `has_parent`, `derived_from`, `replaces`, `relates_to`) with role metadata for specialized meanings. Re-point by retiring the old edge and adding the new one; endpoints are immutable.",
      },
      {
        policy:
          "Walk a process node through the four-stage lifecycle drafting → queued → active → retired. Sketch it in `drafting`, where it may be incomplete — completeness and shape rules are suspended. `queue` it (changeset op `queue`) once its actor (`performed_by`, or `decided_by` for a gateway Decision), Intent (`serves`), and forward `flows_to` wiring are coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules; only a `drafting` sketch is exempt. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).",
      },
      {
        policy:
          "Use `queued` for a process — or a single step, gateway, or milestone — that is fully wired and ready but not yet in force: a redesign awaiting sign-off, a step pending a scheduled go-live, or an approved-but-not-yet-rolled-out change. A `queued` node asserts readiness, so it must already satisfy the same actor, `serves`, and forward-flow wiring an `active` node does. If it is still being sketched and that wiring is incomplete, leave it `drafting` instead of queuing it.",
      },
      {
        policy:
          "Process *instances* (recorded runs) live in a separate Doco as Logs; surface them here only via References. This template describes the design of the process, not the history of its executions.",
      },
      {
        policy:
          "Rules in a business-processes Doco are process policies and guards (`refunds above $5k require manager approval`). Template-authoring rules — meta-rules about how to write process Docos — belong in the template or in `global`, not in any process using it.",
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
    // (decision_01KSDR_PRINCIPAL_SLIM_DOWN) a Principal carries no
    // structured occupant attribute — just `name` + `body_md`; the
    // person / AI-agent / vacant distinction lives in the body_md
    // prose, enforced by a probabilistic policy rather than a
    // `requires_field` check.
    //
    // Reporting and occupancy are first-class edges: has_parent edges carry
    // reports_to / dotted_reports_to roles, and relates_to edges carry the
    // same_occupant_as role. The org tree renders directly from edge rows.
    //
    // Industry alignment (W3C Organization Ontology + HR practice):
    // a seat that can stand vacant approximates `org:Post`; secondary
    // (dotted-line / matrix) reporting layers on top of the single
    // primary reporting edge as additional dotted-line manager edges — drawn
    // dashed, never reparenting the node. A fully
    // structural Post / Membership split — occupant nodes distinct from the seat, a versioned
    // `member_of` / `held_by` edge, a real vacancy field instead of
    // body_md prose — remains a deliberate follow-up rather than
    // half-modeled here.
    name: "org-chart",
    label: "org-chart",
    icon: "🏢",
    description:
      "Map the people and AI agents in an organization — reporting lines, teams, roles, and appointments. Every seat declares in its `body_md` prose whether it's filled by a person, filled by an AI agent, or currently vacant.",
    // No `defaultNodeLifecycle` override: a seat, team, or appointment
    // is live the moment it's created, so a captured node lands
    // `active` (and the completeness rules — e.g. a team Intent's
    // roster, a seat's reporting line — apply right away). Two explicit
    // overrides cover the rest of the four-stage lifecycle: capture a
    // committed-but-not-yet-effective change (a signed hire, an
    // announced reorg) as `queued` — it meets the same completeness bar
    // as active but isn't in force yet — and sketch a tentative seat or
    // roster-less team as `drafting`, where the occupant or reporting
    // line may still be unknown. (Business-processes keeps a `drafting`
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
          "Only Principal, Intent, Decision, Reference, and Rule belong as org-chart nodes. Actions describe activities (use business-processes); States describe stages; Evals describe checks; Logs describe events; Ideas live in their own home.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["principal", "intent", "decision", "reference", "rule"],
        },
      },

      // ── The unique bit — every member declares person or AI agent ──
      {
        // THE DISTINGUISHING CONSTRAINT. The Principal slim-down moved
        // person-vs-agent out of a structured field and into the
        // body_md prose. Org charts still need the declaration, so
        // this probabilistic policy reads body_md and blocks captures
        // that leave the distinction ambiguous. A third state —
        // `vacant` — lets a budgeted-but-unfilled seat live on the
        // chart (HR best practice: omitting open roles breaks headcount
        // and reporting structure). A vacant seat is the closest this
        // template gets to W3C `org:Post` without a schema change.
        policy:
          "Every Principal in an org chart is a seat: its `body_md` must declare whether the seat is filled by a person, filled by an AI agent, or currently vacant. The org-tree perspective infers this from the prose; without an explicit declaration a chart can't tell humans from AI agents from open roles.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["principal"],
          spec: "Read the Principal's `body_md`. PASS if the prose clearly states the seat is filled by a human person (e.g. 'Human director of …', 'Person responsible for …'), filled by an AI agent (e.g. 'AI agent operated by @alice', 'Autonomous research bot'), OR currently vacant/open (e.g. 'Vacant — budgeted Staff Engineer seat, reporting to …'). FAIL with a reason if `body_md` is empty or doesn't take a stance on person / AI agent / vacant.",
        },
      },
      {
        // Deterministic floor under the person/agent/vacant judge above: that
        // declaration lives in `body_md`, so an empty body can't possibly carry
        // it. Catch the empty-shell case deterministically — cheaply, with a
        // crisp error, and even when the LLM judge is unavailable. No lifecycle
        // gate: it matches the judge it floors, which fires on every Principal
        // regardless of stage.
        policy:
          "Every org-chart Principal declares its seat in `body_md` — the person / AI-agent / vacant declaration lives there, so the field must be present.",
        predicate: {
          kind: "requires_field",
          fields: ["body_md"],
          when_node_type: ["principal"],
        },
      },

      // ── Hierarchy: every Principal either reports up or explains root ──
      {
        // A has_parent edge with role=reports_to forms the org tree. This uses
        // a single probabilistic warning rather
        // than a deterministic `requires_edge` predicate because a
        // valid root Principal (CEO/founder/root agent/external
        // authority) should not receive an unavoidable "missing
        // reports_to" warning once its body_md explains the absence.
        //
        // Fires on `queued` AND `active`: a queued seat is a committed,
        // ready-to-go-live org fact (a signed hire, an announced
        // appointment) — as complete as an in-force one, so its reporting
        // line should already be wired. Only `drafting` — the
        // still-being-sketched stage — is exempt, so a member can be
        // captured before its manager exists.
        on_violation: "warn",
        policy:
          "Every in-force or queued Principal in an org chart either has a `has_parent` reporting edge or explains in `body_md` why it is top-of-chain (founder, board-reporting, root agent, external authority).",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["principal"],
          spec: "Read the Principal candidate. PASS if its prose explains why this Principal has no manager above it (founder, board-reporting, root agent, external authority, etc.). Otherwise, expect a has_parent edge with role `reports_to` in the graph; if it is absent, WARN that the reporting edge is missing.",
        },
        fires_when_node_lifecycle: ["queued", "active"],
      },

      // ── Team Intents declare members ───────────────────────────
      {
        // Formerly a `descriptive` predicate (recorded, never enforced); now a
        // deterministic `warn`. A committed team/unit Intent links to its
        // member Principals with outgoing `attributed_to` edges (role `member`,
        // `lead`, …). `warn`, not block: a team that's `queued` to stand up
        // should already name its roster, but a roster wired one member at a
        // time shouldn't hard-fail mid-edit, and a `drafting` team is exempt
        // entirely.
        on_violation: "warn",
        policy:
          "Every in-force or queued team/unit Intent in an org chart is linked to its member Principals with `attributed_to` edges (role `member`, `lead`, …). A team with no members usually means a roster that has not been wired yet.",
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
          "An org chart describes who reports to whom and which teams exist — not what those people do. Activities, processes, and workflows belong in business-processes Docos linked via Reference.",
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
          "AI-agent Principals that act on a human's behalf should declare that human via prose in `body_md` (`Operates under: @alice`), or via a `delegated_by` Decision linking the human Principal to the agent Principal. Autonomous agents (no human owner) state that explicitly so readers know the accountability stops at the agent.",
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
          "A reporting line is a first-class has_parent edge with role `reports_to`. Re-point it by retiring the old edge and adding the new one, and capture the why of the reorg as a Decision so the rationale survives the edit.",
      },
      {
        policy:
          "Role `reports_to` carries exactly one manager — the primary (solid-line) reporting relationship — so the org tree stays a clean hierarchy. Model secondary, dotted-line, or matrix reporting on top of it with has_parent edges carrying role `dotted_reports_to`, drawn dashed without reparenting the node. Don't overload `reports_to` with a second manager.",
      },
      {
        policy:
          "One occupant can hold several seats — the CEO who also acts as VP Eng, a founder covering two roles. Model each seat as its own Principal and link them with `same_occupant_as` edges so the chart knows it's one person, not two. Don't collapse two distinct roles into one Principal just because the same person fills them today.",
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
          "Treat each Principal as a seat — a role plus its current occupant — not just a person. A budgeted-but-unfilled seat is a valid Principal: declare it `vacant` in `body_md`, name the role it's budgeted for, and keep its reporting edge so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure.",
      },
      {
        policy:
          "Person vs agent isn't about who signed in — it's about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.",
      },
      {
        policy:
          "Seats persist across routine turnover: when one person leaves and another fills the same seat — or a seat goes vacant and is later refilled by the same kind of occupant — keep the Principal, update `body_md`, and record the change as a Decision, so reporting and membership edges stay intact and the seat's history reads continuously. Only when the seat's nature flips between person and AI agent do you retire the old Principal and create a new one.",
      },
      {
        // Mirrors the business-processes authoring rule. Org charts are
        // frequently bulk-imported or backfilled by agents (from an HRIS, a
        // Slack roster, a headcount sheet), so the changeset batch — create a
        // seat and wire its reporting edge atomically — is exactly right.
        // This also re-points agents at the CURRENT changeset ops after the
        // `assert`→`activate` rename and the new `queue` op.
        policy:
          "Agents author org changes through `GET /<handle>/api/authoring-contract.json` and `POST /<handle>/api/changesets.json`: create a seat and its `reports_to` edge in one changeset so the tree is never transiently rootless, and use `relate_many` for sibling edges that must hold together — a primary `reports_to` plus its `dotted_reports_to` matrix lines, or the `same_occupant_as` links across one person's seats. Stage a future-effective change with the `queue` op and put it in force with `activate`.",
      },
    ],
  },
];

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored under plain handles (`global`, `important`,
 * `architectural-decisions`, `product-decisions`, `design-decisions`,
 * `data-decisions`, `glossaries`, `business-processes`, `org-chart`).
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
    predicate = { agent_instruction: policy.policy };
  } else if (pred.kind === "probabilistic" || pred.kind === "descriptive") {
    // `descriptive` was recorded-but-not-enforced → folds into suggestion.
    kind = pred.kind === "probabilistic" ? "probabilistic" : "suggestion";
    predicate = {
      agent_instruction: pred.spec,
      ...(pred.when_node_type ? { when_node_type: pred.when_node_type } : {}),
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
