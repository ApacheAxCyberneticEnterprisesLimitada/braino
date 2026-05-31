/**
 * Default Doco templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships curated templates. `global` is the policies
 * template; the others describe common Doco shapes such as business
 * processes, glossaries, org charts, and decision-record collections.
 * Template names are plain handles.
 *
 * Each template ships:
 * - `description` — the description text rendered in the picker and
 *   bootstrap manifest.
 * - `policies` — at install time entries seed Doco-level
 *   policies: prose-only entries become guidance_policies;
 *   predicate-bearing entries become node_authoring_policies.
 * - `allowedNodeTypes` (optional) — a Doco-level allowlist. `global`
 *   ships with policy types so the Doco's policy set is kept
 *   separate from domain Rule nodes.
 *
 * Template policy entries seed Doco-level policies, split purely by
 * predicate-presence: prose-only entries become guidance_policies,
 * predicate-bearing entries become node_authoring_policies (see
 * host.ts). The historical Rule.kind overloading (guidance / authoring /
 * tagged) is gone — meta-constraints are policies, not Rule nodes
 * (decision_01KRRR5BQ16ASY8HQEE0V499YG).
 */
import type { AuthoringPredicate, Lifecycle } from "@doco/shared";

export interface TemplatePolicy {
  /** The one-line rule statement. Renamed from `summary` to `policy`
   *  in migration 038 to match the migration-023 type-named-prose
   *  pattern. For predicate-bearing policies this is the reason text
   *  that accompanies the structured check; for guidance policies
   *  this is the policy itself. */
  policy: string;
  /**
   * Engine-readable predicate. When set, the seeder creates a
   * node_authoring_policy so the check can run during capture.
   */
  predicate?: AuthoringPredicate;
  /**
   * v7: when set, the engine only fires this policy against
   * candidates whose `lifecycle` is in the list. Used by completeness
   * rules that skip drafting nodes during mid-construction.
   */
  fires_when_node_lifecycle?: Lifecycle[];
  /**
   * Override the seeded policy's `on_violation` behavior. Defaults
   * to "block" when unset. Use "warn" for soft / probabilistic rules
   * the author wants surfaced but not enforced (e.g. semantic
   * membership gates), and "log" for purely descriptive recording.
   */
  on_violation?: "block" | "warn" | "log";
  /**
   * Optional markdown body. Renders alongside the summary on the
   * policy detail page.
   */
  body_md?: string;
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
   * perspectives (graph, list, for-approval) are always attached even
   * if this list is empty; entries here append after them. The
   * business-processes template ships `[{slug:"bpmn"}]` so a Doco
   * created from that template arrives with the BPMN tab ready.
   */
  perspectives?: TemplatePerspectiveAttachment[];
  /**
   * Doco-level allowlist for captured node types. `global` keeps the
   * Doco policy set focused by accepting only policy types.
   */
  allowedNodeTypes?: (
    | "decision"
    | "intent"
    | "action"
    | "rule"
    | "guidance_policy"
    | "node_authoring_policy"
    | "log"
    | "eval"
    | "reference"
    | "idea"
    | "state"
  )[];
  /**
   * When set, captures into a Doco created from this template default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The business-processes template
   * uses `"drafting"` so authors can sketch incomplete processes
   * without tripping completeness rules.
   */
  defaultNodeLifecycle?: Lifecycle;
}

const DECISION_RECORD_ENTITY_TYPES = [
  "intent",
  "decision",
  "eval",
  "reference",
  "rule",
  "principal",
  "guidance_policy",
  "node_authoring_policy",
] as const;

interface DecisionRecordTemplatePolicyOptions {
  membershipPolicy: string;
  membershipSpec: string;
  qualityPolicy: string;
  qualitySpec: string;
  guidance: string[];
}

function decisionRecordPolicies(opts: DecisionRecordTemplatePolicyOptions): TemplatePolicy[] {
  return [
    {
      on_violation: "warn",
      policy: opts.membershipPolicy,
      predicate: {
        kind: "probabilistic",
        spec: opts.membershipSpec,
        when_node_type: ["intent", "decision", "eval", "reference", "rule", "principal"],
      },
    },
    {
      policy:
        "Only Intent, Decision, Eval, Reference, Rule, Principal, and the Doco's own policies belong in a decision-record Doco. Actions, Logs, States, and Ideas belong in sibling Docos unless promoted into an actual decision record.",
      predicate: {
        kind: "requires_entity_type",
        entity_types: [...DECISION_RECORD_ENTITY_TYPES],
      },
    },
    {
      policy:
        "Every active decision-record Decision declares `question`, `chosen`, and `alternatives`: the issue being decided, the selected resolution, and the options considered.",
      predicate: {
        kind: "requires_field",
        fields: ["question", "chosen", "alternatives"],
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: ["asserted"],
    },
    {
      on_violation: "warn",
      policy:
        "Active decision-record Decisions should have unique `question` values. If the same question is revisited, retire or supersede the old record and link it to the successor rather than silently rewriting history.",
      predicate: {
        kind: "unique_field",
        field: "question",
        case_fold: true,
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: ["asserted"],
    },
    {
      on_violation: "warn",
      policy: opts.qualityPolicy,
      predicate: {
        kind: "probabilistic",
        when_node_type: ["decision"],
        spec: opts.qualitySpec,
      },
      fires_when_node_lifecycle: ["asserted"],
    },
    {
      policy:
        "Decision records are append-only once asserted: correct or replace them by retiring or superseding the old Decision and creating a successor, not by editing away the original context, rationale, or rejected alternatives.",
    },
    {
      policy:
        "Use References for source material and implementation evidence, Rules for enduring policy that falls out of a decision, Evals for validation or follow-up checks, and Intents for the goal or outcome the decision serves.",
    },
    ...opts.guidance.map((policy) => ({ policy })),
  ];
}

export const DEFAULT_DOCO_TEMPLATES: DocoTemplate[] = [
  {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded
    // template renamed to "global"; template names
    // are plain handles.
    name: "global",
    label: "global policies",
    icon: "🌐",
    description:
      "Your doco's global policies — guidance policies and node-authoring policies that govern how contributors work.",
    allowedNodeTypes: ["guidance_policy", "node_authoring_policy"],
    policies: [
      {
        policy:
          "Capture each meaningful decision, correction, and load-bearing implementation outcome in Doco.",
      },
      {
        policy: "If you're an agent, check with your client before changing the policies.",
      },
      {
        policy:
          "AI agents: document every explicit rule and decision from the project owner, and especially every correction. Corrections are the highest-signal moments — they encode preferences that aren't visible in the code or docs. Capture them in Doco the same turn they happen, so the next agent (or the next session of you) doesn't repeat the mistake.",
      },
      {
        policy:
          "Nothing is ever deleted — nodes and edges are retired, not removed, and every prior version stays recoverable. When you retire or change something load-bearing, say why in the change's reason so the history explains itself to whoever reads it next.",
      },
    ],
  },
  {
    // Catch-all template for important Doco-wide decisions that don't
    // naturally fit a more specific subject area.
    name: "important",
    label: "important",
    icon: "⭐",
    description:
      "Important doco-wide decisions that don't naturally fit a more specific subject area.",
    policies: [],
  },
  {
    name: "architectural-decisions",
    label: "Architectural decisions",
    icon: "🏛️",
    description:
      "Document architectural decision records — system structure, interfaces, infrastructure, quality attributes, constraints, alternatives, and consequences.",
    policies: decisionRecordPolicies({
      membershipPolicy:
        "A node belongs in architectural-decisions when it records or supports an architectural decision: system structure, API or integration boundaries, infrastructure, quality attributes, operational constraints, security/compliance architecture, implementation evidence, or an architecture validation check.",
      membershipSpec:
        "PASS for ADRs, architecture goals, architecture principles, technology-selection records, security/privacy architecture constraints, References to RFCs/specs/PRs, Evals that validate an architectural claim, and Principals representing accountable technical owners or review bodies. FAIL for product roadmap choices, UI design choices, raw incidents, implementation tasks without architectural consequence, or data-definition decisions better owned by data-decisions.",
      qualityPolicy:
        "An active architectural Decision reads like an ADR: it states context and problem, decision drivers or quality attributes, options considered, chosen approach, consequences and trade-offs, implementation/migration impact, and the review or rollback trigger.",
      qualitySpec:
        "Check the Decision's `decision`, `question`, `chosen`, and `alternatives`. PASS when the record includes (1) context/problem, (2) decision drivers such as quality attributes, constraints, or forces, (3) realistic alternatives considered, (4) rationale for the chosen architecture, (5) consequences/trade-offs/risks, and (6) implementation, migration, rollback, or revisit implications. FAIL with the missing aspects when it only states a choice without rationale, lacks alternatives, omits consequences, or leaves no path for implementation/review.",
      guidance: [
        "Create an architectural Decision for choices that are hard to reverse or broadly consequential: platform/runtime choices, service boundaries, data ownership across systems, API contracts, security controls, reliability targets, deployment topology, build/release architecture, or cross-team technical standards.",
        "Architectural Decisions that create enduring technical rules should spawn or link Rules, such as API compatibility rules, service ownership rules, dependency constraints, or security requirements.",
        "Link implementation PRs, migration plans, diagrams, benchmark results, threat models, and incident learnings as References so the ADR remains explainable after the code has moved on.",
        "Architecture records name the accountable technical owner or review group in `decided_by` or prose, and call out product, design, data, security, or operations stakeholders when the decision crosses those boundaries.",
      ],
    }),
  },
  {
    name: "product-decisions",
    label: "Product decisions",
    icon: "🧭",
    description:
      "Document product decision records — user/customer evidence, scope, positioning, pricing, roadmap choices, success metrics, alternatives, and revisit triggers.",
    policies: decisionRecordPolicies({
      membershipPolicy:
        "A node belongs in product-decisions when it records or supports a product decision: target users, problem framing, scope, roadmap priority, launch strategy, pricing/packaging, growth motion, success metrics, experiment interpretation, or a deliberate decision not to build something.",
      membershipSpec:
        "PASS for product decision records, product goals, product principles, customer/research References, Evals for experiments or metrics, and Principals representing product decision roles. FAIL for engineering implementation choices, visual/interface design details better owned by design-decisions, pure data-governance choices, one-off support events, or unpromoted feature ideas with no decision yet.",
      qualityPolicy:
        "An active product Decision states the user/customer problem, strategic goal, evidence, assumptions, options considered, chosen product direction, explicit trade-offs, success metric, accountable decision role, and revisit trigger.",
      qualitySpec:
        "Check the Decision's `decision`, `question`, `chosen`, and `alternatives`. PASS when it includes (1) the user/customer problem and affected segment, (2) strategic or OKR alignment, (3) evidence such as research, feedback, analytics, sales/support signal, or experiment data, (4) assumptions and constraints, (5) realistic alternatives including the status quo or not-building option, (6) trade-offs and expected impact, (7) a success/failure metric or learning goal, and (8) a decision owner/approval role or revisit trigger. FAIL with missing aspects when it reads as a feature wish, ungrounded opinion, or roadmap assertion without evidence and metrics.",
      guidance: [
        "Record `we will not do X` product calls when the choice changes scope, user expectations, sales promises, or future roadmap reasoning; negative decisions are often more valuable than shipped-feature notes.",
        "Use Evals for experiments, A/B tests, metric reviews, or qualitative checks that prove whether the product Decision worked, and link follow-up Decisions when the evidence changes the course.",
        "Product Decisions separate reversible experiments from committed strategy: two-way-door tests can stay drafting or time-boxed, while one-way-door commitments should be asserted with explicit approval and revisit criteria.",
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
    policies: decisionRecordPolicies({
      membershipPolicy:
        "A node belongs in design-decisions when it records or supports a design decision: user journeys, interaction patterns, service flows, content strategy, accessibility behavior, design-system conventions, visual hierarchy with product meaning, research findings, prototypes, or usability validation.",
      membershipSpec:
        "PASS for design decision records, design goals, design-system Rules, research or Figma References, usability/accessibility Evals, and Principals representing design reviewers or accountable owners. FAIL for raw engineering architecture, product priority calls without UX implications, data governance decisions, or cosmetic preference notes with no user or system rationale.",
      qualityPolicy:
        "An active design Decision states the user journey or service moment, evidence, alternatives considered, chosen pattern, affected states and edge cases, accessibility/content implications, trade-offs, artifacts, and validation plan.",
      qualitySpec:
        "Check the Decision's `decision`, `question`, `chosen`, and `alternatives`. PASS when it includes (1) the user journey, service moment, or interface state being decided, (2) evidence from research, support, analytics, accessibility review, or product constraints, (3) alternatives considered, preferably linked to artifacts, (4) chosen design pattern and rationale, (5) affected states including empty/error/loading/permission/responsive states when relevant, (6) accessibility, content, localization, or design-system implications, (7) trade-offs and risks, and (8) validation or rollout plan. FAIL when it only says what the UI looks like without explaining users, evidence, alternatives, states, or validation.",
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
    policies: decisionRecordPolicies({
      membershipPolicy:
        "A node belongs in data-decisions when it records or supports a data decision: source-of-truth ownership, canonical metric or entity definitions, schema and contract choices, lineage, quality/freshness targets, retention, privacy classification, access controls, migration/backfill plans, or consumer-impact validation.",
      membershipSpec:
        "PASS for data decision records, data-governance goals, data Rules, data contract References, quality or freshness Evals, and Principals representing data owners, stewards, producers, or consumer groups. FAIL for UI design decisions, generic product roadmap choices, pure application architecture with no data ownership/semantics impact, or raw pipeline run Logs.",
      qualityPolicy:
        "An active data Decision states the data asset or definition, accountable owner/steward, producers and consumers, source of truth, schema or semantics, privacy/access/retention stance, quality and freshness expectations, lineage, migration/backfill impact, and monitoring/revisit plan.",
      qualitySpec:
        "Check the Decision's `decision`, `question`, `chosen`, and `alternatives`. PASS when it includes (1) the data asset, metric, event, dataset, or contract being decided, (2) accountable owner or steward, (3) producers and consumers or affected systems, (4) canonical source of truth and semantic definition, (5) schema/contract or compatibility implications, (6) classification, privacy, access, and retention considerations when relevant, (7) data quality/freshness/SLA expectations and lineage, (8) migration, backfill, rollback, or downstream impact, and (9) monitoring or revisit trigger. FAIL when it records a data choice without ownership, semantics, consumers, governance, or operational impact.",
      guidance: [
        "Prefer machine-readable data contracts where possible, and link them as References; the Decision explains why the contract exists while the contract defines the enforceable schema and expectations.",
        "Metric and source-of-truth Decisions should define exactly what is included, excluded, and time-bounded so dashboards, experiments, and product claims do not drift into incompatible meanings.",
        "Breaking data changes require a migration/backfill plan, downstream-consumer notice, compatibility strategy, and rollback or reconciliation path before the Decision is asserted.",
        "Use Rules for enduring governance constraints such as access tiers, retention limits, PII handling, ownership boundaries, and quality thresholds; use Evals to monitor freshness, completeness, drift, or contract compliance.",
      ],
    }),
  },
  {
    // Glossaries define product and domain language. Each active term
    // entry is a Decision: `question` names the concept, `chosen` is the
    // canonical term, and `decision` holds the definition, scope, and
    // examples. List is the natural authoring surface for terminology.
    //
    // Term relationships use the two flavors the managed-edge architecture
    // defines, one of each. `relates_to` is a directly-authored edge (origin
    // "authored") — added and retired through the edges API, with immutable
    // endpoints, exactly like business-processes' `serves` / `sequence_flow`
    // — linking confusable, parent/sub, or homograph terms. `superseded_by`
    // (a deprecated term → its replacement) is authored as a field on the
    // term and projected by the capture path into a first-class
    // `superseded_by` edge (origin "field"): the same field→edge model as
    // business-processes' `actor_id` / `parent_intent_id`, not the
    // history-less `deriveEdges` projection org-chart uses for `reports_to`.
    // The node-table collapse dropped the `superseded_by` FK column
    // (migration 074), so neither relationship carries a database foreign
    // key — target existence is app-enforced, like every other edge.
    name: "glossaries",
    label: "Glossaries",
    icon: "📚",
    description:
      "Document product and domain terminology — canonical terms, definitions, aliases, deprecated wording, sources, and consistency checks.",
    // No `defaultNodeLifecycle` override: a glossary term is a
    // definitional, complete-on-creation node, so a captured term lands
    // live (`asserted`) and the term-completeness gates apply right
    // away. Authors who want to stub a term sketch it explicitly with
    // `lifecycle: "drafting"`. (Contrast business-processes, which
    // defaults to `drafting` so a flow can be wired up incrementally.)
    // The dictionary-styled Glossary perspective is the natural reading
    // surface for terminology, so a Doco created from this template
    // opens directly on it. Graph + list defaults stay attached behind.
    perspectives: [{ slug: "glossary", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        on_violation: "warn",
        policy:
          "A node belongs in glossaries when it defines product or domain terminology, records a terminology choice, cites an authoritative source, states a terminology usage rule, or checks terminology consistency. Feature work, process flows, org charts, and runtime events belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in glossaries when it defines product or domain terminology, records a terminology choice, cites an authoritative source, states a terminology usage rule, or checks terminology consistency. PASS for term entries, glossary scope, terminology usage rules, references to source glossaries/specs/docs, and evals that scan terminology consistency. FAIL for feature implementation work, process flows, org charts, runtime incidents, or state-machine stages.",
          when_node_type: ["intent", "decision", "rule", "reference", "eval"],
        },
      },
      {
        policy:
          "Only Intent, Decision, Rule, Reference, Eval, and policies belong in glossaries. Actions, Logs, States, Ideas, and Principals have their own homes.",
        predicate: {
          kind: "requires_entity_type",
          entity_types: [
            "intent",
            "decision",
            "rule",
            "reference",
            "eval",
            "guidance_policy",
            "node_authoring_policy",
          ],
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
        fires_when_node_lifecycle: ["asserted"],
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
        fires_when_node_lifecycle: ["asserted"],
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
          "A glossary term-entry Decision defines exactly one concept with a usable definition. It keeps one concept per entry, its `decision` prose gives a concise definition plus the product/domain scope, and — when the canonical term in `chosen` is itself an acronym or abbreviation — spells out the expanded form and says when the short form is acceptable.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "Judge a glossary term-entry Decision on three aspects; report each failing aspect with a reason, but treat them as warnings, not hard errors. (a) ONE CONCEPT: PASS when the entry defines one concept or one canonical term; FAIL when it defines multiple independent terms, bundles a term with an unrelated policy, or is a catch-all for several concepts. (b) USABLE DEFINITION: PASS when the `decision` prose gives a concise definition AND the product or domain scope where the term applies AND at least one concrete example OR non-example — EITHER an example or a non-example is sufficient, do not require both; FAIL only when one of those three is genuinely absent. (c) ACRONYMS AND ABBREVIATIONS: only inspect the canonical term in `chosen`. If `chosen` is itself an acronym or abbreviation, PASS when the prose expands it at least once and states whether the short form is acceptable in product/docs/UI copy; FAIL when it is left unexpanded. Incidental abbreviations that merely appear in the prose (not the headword) are OUT OF SCOPE — ignore them. If `chosen` is not an acronym, this aspect PASSES.",
        },
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Eval shape ─────────────────────────────────────────────
      {
        policy:
          "Every active glossary Eval declares `target_ref` and `how_to_run` so terminology consistency checks can be rerun.",
        predicate: {
          kind: "requires_field",
          fields: ["target_ref", "how_to_run"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: ["asserted"],
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
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Guidance ───────────────────────────────────────────────
      {
        policy:
          "When rejected, deprecated, misleading, synonymous, or historical terms exist, record them in `alternatives`; otherwise omit `alternatives` rather than inventing filler.",
      },
      {
        policy:
          "When two distinct concepts share a surface form (homographs, e.g. `Order` in commerce vs. `Order` as a sort operation), give each its own Decision and disambiguate `chosen` with a qualifier — `Order (commerce)` vs. `Order (sorting)` — so every entry stays uniquely addressable.",
      },
      {
        policy:
          "Connect related glossary terms in the graph instead of leaving entries isolated — author a `relates_to` edge to link a term to terms it is easily confused with, its parent or sub-concepts, or the homographs it shares a surface form with, so the vocabulary reads as a navigable network. `relates_to` is a directly-authored edge with immutable endpoints (like a process's `sequence_flow`): change a link by retiring the old edge and adding a new one, not by editing endpoints in place. Deprecation links use `superseded_by` instead (see below) — that one is field-authored, not added as an edge.",
      },
      {
        policy:
          "Borrowed, standards-based, or industry terms cite a Reference when possible. Product-internal terms state that they are product-specific so readers don't mistake them for external standards.",
      },
      {
        policy:
          "Retired glossary Decisions point at the replacement term via `superseded_by`, and keep the deprecated term visible so readers still understand old docs, tickets, and UI copy. `superseded_by` is authored on the retiring term and projects into a first-class `superseded_by` edge (term → replacement term) with its own lifecycle and history — the same fields-as-edges model the node-table collapse settled on when it dropped the promoted FK columns. That edge carries no database foreign key, so the replacement's existence is app-enforced, not guaranteed by the DB: point `superseded_by` at a term that already exists, and re-point it by editing the field so the capture path reconciles the edge (retiring the stale one, adding the new) rather than overwriting a pointer in place.",
      },
      {
        policy:
          "Use Rules for terminology usage policies, such as banned words, capitalization conventions, UI copy constraints, or when two related terms must not be used interchangeably.",
      },
    ],
  },
  {
    // Repeatable business processes modeled on BPMN swimlanes and
    // gateways. Sequence flow is explicit via `sequence_to`, which
    // materializes as `sequence_flow`; flow normally runs forward, but
    // rework loops may route back through a gateway. Generic Doco
    // dependency / rationale edges remain associations and are not
    // treated as BPMN arrows.
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
        // the entity-type allowlist; their quality is governed by the
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
        // Deterministic entity-type allowlist. Logs (recorded executions)
        // live in a sibling Doco and are surfaced here via Reference;
        // Ideas live in their own home until promoted. The Doco's own
        // policies (guidance_policy / node_authoring_policy) are admitted
        // so authors can add process-specific authoring rules in place —
        // policy candidates carry no `node_type`, so a node-only gate
        // would block them (this gate fires against every candidate).
        policy:
          "Only Intent, Action, Decision, State, Eval, Reference, Rule, Principal, and the Doco's own policies belong here. Logs (recorded executions) live in a sibling Doco and are referenced from here; Ideas live in their own home until promoted.",
        predicate: {
          kind: "requires_entity_type",
          entity_types: [
            "intent",
            "action",
            "decision",
            "state",
            "eval",
            "reference",
            "rule",
            "principal",
            "guidance_policy",
            "node_authoring_policy",
          ],
        },
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
        // Probabilistic on intent — the trigger, terminal business
        // outcome, and out-of-scope boundary must all be discernible
        // from the Intent's `intent` field.
        policy:
          "The purpose Intent of a business process names the trigger that starts the process, the terminal business outcome that ends it, and what is explicitly out of scope. Readers should be able to discern all three from the Intent's `intent` field.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Intent's `intent` field. The purpose Intent of a business process must name (1) the trigger that starts the process, (2) the terminal business outcome that ends it, and (3) what is explicitly out of scope. PASS if all three are discernible; FAIL with which is missing if one or more is absent.",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Action shape ────────────────────────────────────────────
      {
        policy:
          "Every Action in business-processes must declare the principal who performs the activity in the `actor_id` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: ["asserted"],
      },
      {
        // Team-roles (`kitchen`, `support`, `finance`) are first-class
        // Principals representing a role rather than an individual.
        // (Post-rename, person/agent distinction moved to User;
        // the engine just enforces principal resolution.)
        policy:
          "An Action's `actor_id` must resolve to an existing Principal. Team-roles (e.g. `kitchen`, `support`, `finance`) are first-class Principals — model them as Principals representing a role rather than an individual.",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: ["asserted"],
      },
      {
        // One rule for all three flow-node types. `requires_edge` filters
        // by `when_node_type`, so a single policy covers Action, gateway
        // Decision, and milestone State — they share the same constraint
        // (be tied to a concrete process/pool) and previously shipped as
        // three near-identical entries.
        policy:
          "Every flow node in business-processes — Action, gateway Decision, or milestone State — must `serves` an Intent. Without it the BPMN renderer can't place the node in a pool, and the step floats free of the business outcome it advances.",
        predicate: {
          kind: "requires_edge",
          edge_type: "serves",
          target_node_type: "intent",
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: ["asserted"],
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
        fires_when_node_lifecycle: ["asserted"],
      },
      // ── Decision shape ──────────────────────────────────────────
      {
        // Exhaustive branches: question reads as yes/no or enumerated,
        // and the alternatives list either has a default/else branch
        // or covers every enum value.
        policy:
          "Gateway Decisions in business-processes have exhaustive outgoing branches. The `question` reads as yes/no or an enumerated choice, and the `alternatives` plus `sequence_to` branch labels either include a default/else branch or name every enum value.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Decision's `question`, `alternatives`, and any `sequence_to` branch labels/conditions. PASS when the question reads as yes/no or an enumeration, AND the alternatives / outgoing branches either include an explicit default/else branch or name every enumerated value. FAIL with reason if the question has uncovered cases or if a default/else is missing where enum coverage isn't visibly complete.",
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── State shape & sequence wiring (graph invariants kept as
      //    guidance until the evaluator can express subgraph shape) ──
      {
        policy:
          "A business process has ≥1 active initial State and ≥1 active terminal State, with each `state` name unique within the process. Every process starts somewhere, ends at a business outcome (or an explicitly cancelled outcome), and names its milestones unambiguously.",
      },
      {
        policy:
          "Flow runs forward from the initial State: each active initial State has ≥1 outgoing `sequence_to`, every non-initial flow node is reachable from an earlier flow node through forward `sequence_to`, and every non-terminal flow node has ≥1 outgoing `sequence_to` target in the same process Intent. Terminal States have no outgoing `sequence_to` — they end the process path.",
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
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Coverage ────────────────────────────────────────────────
      {
        // Each principal listed on an Intent's `actors` must be the
        // actor_id of ≥1 Action serving the Intent. Fires only when
        // the Intent moves to `asserted` so drafting Intents can be
        // sketched first and have their Actions filled in later.
        policy:
          "Every principal listed in an Intent's `actors` must be the `actor_id` of at least one Action that `serves` the Intent. Fires when the Intent is asserted — drafting Intents are allowed to be incomplete.",
        predicate: {
          kind: "graph-completeness",
          list_field: "actors",
          edge_type: "serves",
          incoming_node_type: "action",
          incoming_field_must_match: "actor_id",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Eval ────────────────────────────────────────────────────
      {
        policy:
          "Every Eval in business-processes must declare its `target_ref` — the node whose claim the Eval pins.",
        predicate: {
          kind: "requires_field",
          fields: ["target_ref"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: ["asserted"],
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
          "When a step is itself a whole sub-process, model it as its own child process Intent and link the calling Action to that Intent (the BPMN call-activity pattern) instead of inlining dozens of Actions. The BPMN view collapses the child Intent into its own pool, keeping the parent process readable.",
      },
      {
        policy:
          "Name the single accountable process owner in the purpose Intent — the Principal answerable for the whole process's outcome. This is the RACI 'Accountable' role, distinct from the per-step 'Responsible' actors named in each Action's `actor_id`.",
      },
      {
        policy:
          "Agents should read `GET /<handle>/api/authoring-contract.json` and write structured flows with `POST /<handle>/api/changesets.json`; create flow nodes with their incoming `sequence_flow` edge in the same changeset instead of creating disconnected nodes. A node's own-field relations (`serves` via `intent_ids`, the actor via `actor_principal_id`, `gated_by`, `sequence_to`) can be set inline in the create `body` with `$alias` references, so a node can be created already `asserted` and fully wired in one op — no draft-then-assert round trip.",
      },
      {
        policy:
          "Use `relate_many` for sibling edges that must be valid together, especially exhaustive gateway branches. Adding one branch at a time can create a temporarily invalid BPMN graph.",
      },
      {
        policy:
          "BPMN vocabulary: use `sequence_to` for forward process flow; it materializes as `sequence_flow` and renders source -> target with no reversal. Use `intent_ids`/`serves` for pool membership, `gated_by` for policy guards, and `decision_ids` only for rationale/provenance associations.",
      },
      {
        policy:
          "`sequence_to` may be a list of target ids or objects like `{ target, label, condition, kind }`. Put gateway branch labels and default/exception/timer metadata on the outgoing edge, not by reversing a relationship from the downstream Action back to the Decision.",
      },
      {
        policy:
          "For parallel work, give one flow node multiple unconditional `sequence_to` targets — an AND-split needs no gateway Decision. Reserve gateway Decisions for exclusive or conditional (XOR/inclusive) branching, and reconverge parallel branches on a shared downstream node.",
      },
      {
        policy:
          "Rework and retry loops are allowed: a `sequence_to` may target an earlier flow node to send work back (revise-and-resubmit, fix-and-recheck). Route the loop back through a gateway Decision so the cycle has an explicit exit and can't spin forever. A single edge still renders source -> target — a loop is about where the edge points, not reversing its direction.",
      },
      {
        policy:
          'Model the unhappy path. Use `sequence_to` objects with `kind: "exception"` or `kind: "timer"` to route failures, rejections, and timeouts to a recovery step or an explicitly cancelled terminal State, so the process documents what happens when the happy path does not hold.',
      },
      {
        policy:
          "Edges are first-class: a `serves`, `sequence_flow`, or `gated_by` edge has its own lifecycle and history, and its endpoints are immutable. To reroute the process — send a step to a different next step, or move an Action under another Intent — retire the old edge and add the new one instead of editing endpoints in place. Nothing is deleted; the previous wiring stays recoverable with the reason it changed.",
      },
      {
        policy:
          "Some node-to-node links are authored as fields rather than added directly as edges. An Action's actor (`actor_id`) and a sub-process's `parent_intent_id` are authored on the node, and the capture path projects each into a first-class edge — `performed_by` (Action → Principal) and `has_parent` (Intent → Intent) — so each carries its own lifecycle and history like any other edge. There is no promoted column and no database foreign key behind them: existence is app-enforced (the uniform model the node-table collapse settled on when it dropped the intra-node FK columns), and the `actor_id`-resolves-to-a-Principal rule is what catches a dangling actor at capture time. Point them at ids that already exist. Re-point one by editing the field in place — it versions with the node and the capture path reconciles the projected edge for you — unlike `serves` / `sequence_flow` / `gated_by`, which you author directly as edges and reroute by retiring the old edge and adding a new one.",
      },
      {
        policy:
          "Drafting nodes may be incomplete while the process is being sketched. Move flow nodes and the purpose Intent to `asserted` only after actor assignments, Intent links, and forward `sequence_to` wiring are coherent.",
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
      "Track a GitHub repository's pull requests as References — new PRs sync automatically, and merged PRs settle as asserted.",
    policies: [],
    // Default the overview to the Pull requests perspective (seeded by
    // migration 076). Resolved by slug at apply time; silently skipped if the
    // builtin row isn't present.
    perspectives: [{ slug: "pull-requests", isDefault: true }],
  },
  {
    // Organizational chart template. Principals are the org *seats*
    // (a role plus its current occupant), `reports_to` edges form the
    // primary hierarchy, Intents represent teams/units, Decisions
    // record reorgs and appointments. After the Principal slim-down
    // (decision_01KSDR_PRINCIPAL_SLIM_DOWN) a Principal carries no
    // structured occupant attribute — just `name` + `body_md`; the
    // person / AI-agent / vacant distinction lives in the body_md
    // prose, enforced by a probabilistic policy rather than a
    // `requires_field` check.
    //
    // Reporting and occupancy are modeled as *relationship pointer
    // fields*, not columns: `reports_to`, `dotted_reports_to`, and
    // `same_occupant_as` are ID-shaped refs in the Principal's `data`
    // that `deriveEdges` projects into graph edges for the org-tree to
    // render and traverse. They are neither promoted columns nor
    // separately-authored edges — none is in MANAGED_RELATION_EDGE_TYPES,
    // none carries a DB foreign key, so target existence is app-enforced
    // and you re-point one by editing the field in place (it versions
    // with the node). That is the uniform model the node-table collapse
    // settled on when it dropped the five promoted intra-node FK columns:
    // a node→node relationship stays a pointer field unless it is
    // deliberately promoted to a first-class authored edge (own
    // lifecycle, immutable endpoints, rerouted by retire-and-add).
    //
    // Industry alignment (W3C Organization Ontology + HR practice):
    // a seat that can stand vacant approximates `org:Post`; secondary
    // (dotted-line / matrix) reporting layers on top of the single
    // primary `reports_to` line as a structured `dotted_reports_to`
    // list of additional managers — drawn dashed, never reparenting the
    // node. Those refs live in `data` (not promoted columns), so adding
    // them needed no migration. A fully structural Post / Membership
    // split — occupant nodes distinct from the seat, a versioned
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
    // `asserted` (and the asserted-gated completeness rules — e.g. a
    // team Intent's roster — apply right away). To sketch a tentative
    // seat or a roster-less team, pass `lifecycle: "drafting"`
    // explicitly. (Business-processes keeps a `drafting` default so a
    // flow can be wired up incrementally.)
    perspectives: [{ slug: "org-tree", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Deterministic entity-type allowlist. Org charts are made of
        // Principals (members), Intents (teams/units), Decisions
        // (appointments / reorgs), References (external org diagrams,
        // headcount budgets), and Rules (delegation policies).
        // Actions, States, Evals, Logs, and Ideas have their own
        // homes; an org chart describes who reports to whom, not
        // what they do. The Doco's own policies (guidance_policy /
        // node_authoring_policy) are admitted too so authors can add
        // org-specific authoring rules in place — policy candidates
        // carry no `node_type`, so a node-only gate would block them.
        policy:
          "Only Principal, Intent, Decision, Reference, Rule, and the Doco's own policies belong in an org chart. Actions describe activities (use business-processes); States describe stages; Logs describe events; Ideas live in their own home.",
        predicate: {
          kind: "requires_entity_type",
          entity_types: [
            "principal",
            "intent",
            "decision",
            "reference",
            "rule",
            "guidance_policy",
            "node_authoring_policy",
          ],
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

      // ── Hierarchy: every Principal either reports up or explains root ──
      {
        // `reports_to` is a Principal→Principal edge that forms the
        // org tree. This uses a single probabilistic warning rather
        // than a deterministic `requires_edge` predicate because a
        // valid root Principal (CEO/founder/root agent/external
        // authority) should not receive an unavoidable "missing
        // reports_to" warning once its body_md explains the absence.
        on_violation: "warn",
        policy:
          "Every active Principal in an org chart either declares `reports_to` (the Principal they report to) or explains in `body_md` why it is top-of-chain (founder, board-reporting, root agent, external authority).",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["principal"],
          spec: "Read the Principal candidate. PASS if `reports_to` is a non-empty Principal id. Otherwise, PASS only if `body_md` explains why this Principal has no manager above it (founder, board-reporting, root agent, external authority, etc.). FAIL with reason when an active Principal has no `reports_to` and `body_md` does not explain the missing reporting edge.",
        },
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Team Intents declare members ───────────────────────────
      {
        // Team / org-unit Intents (engineering, kitchen, support, etc.)
        // declare their member Principals in `actors`. This mirrors
        // the business-processes convention. Stakeholders
        // (people interested in the unit's outcomes without being on
        // the team) optionally go in `stakeholders`.
        //
        // Gated to `asserted` so a team can be sketched first and have
        // its roster filled in later — the template defaults new nodes
        // to `drafting`, and an ungated requires_field would block that
        // sketch the moment the unit is created. Matches the
        // asserted-gating glossaries and business-processes use on
        // their own completeness rules.
        policy:
          "Every Intent in an org chart must declare `actors` — the Principals who are members of this team or unit.",
        predicate: {
          kind: "requires_field",
          fields: ["actors"],
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["asserted"],
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "An org chart describes who reports to whom and which teams exist — not what those people do. Activities, processes, and workflows belong in business-processes Docos linked via Reference.",
      },
      {
        policy:
          "`reports_to` chains must not be circular. A cycle (A reports to B, B reports to C, C reports to A) usually means a refactor in progress; resolve it before activating the affected Principals. The framework evaluator can't check this yet — it's a manual review.",
      },
      {
        policy:
          "AI-agent Principals that act on a human's behalf should declare that human via prose in `body_md` (`Operates under: @alice`), or via a `delegated_by` Decision linking the human Principal to the agent Principal. Autonomous agents (no human owner) state that explicitly so readers know the accountability stops at the agent.",
      },
      {
        policy:
          "Capture reorgs, hires, departures, and role changes as Decisions, and link the affected Principals via `decision_ids`. Org charts churn; without Decisions, the history of WHY a reporting line moved is lost.",
      },
      {
        policy:
          "Team membership lives in the Intent's `actors` list, which the org-tree renders but does not version. When someone joins or leaves a team, record it as a Decision linking the affected Principals so the *why* and *when* survive the in-place edit. Once a Doco needs real join/leave history, promote membership to a first-class `member_of` edge — own lifecycle, immutable endpoints, rerouted by retiring the old edge and adding a new one — instead of overwriting the `actors` list, which leaves no trail. (`reports_to` would graduate to a versioned edge the same way; today it is still an in-place pointer field — see below.)",
      },
      {
        policy:
          "`reports_to` is an id-shaped pointer field in the Principal's `data`, not a separately-lifecycled edge: `deriveEdges` projects it into a `reports_to` graph edge for the org-tree to draw, but it carries no independent history of its own. Re-point a reporting line by editing the field in place (it versions with the node), and capture the *why* of the reorg as a Decision so the rationale survives the edit. Since the inter-node foreign keys were dropped, nothing at the database layer guarantees the manager id resolves — point it at a Principal that already exists.",
      },
      {
        policy:
          "`reports_to` carries exactly one manager — the primary (solid-line) reporting relationship — so the org tree stays a clean hierarchy. Model secondary, dotted-line, or matrix reporting on top of it with `dotted_reports_to` — a list of manager Principal ids in the Principal's `data` that, like `reports_to`, project graph edges (drawn dashed) without reparenting the node. They are pointer fields, not separately-lifecycled edges: add, drop, or move a dotted line by editing the list in place (it versions with the node), and add a Decision when a matrix assignment needs rationale (project lead, functional vs operational manager). Don't overload `reports_to` with a second manager — it breaks the primary tree the perspective draws.",
      },
      {
        policy:
          "One occupant can hold several seats — the CEO who also acts as VP Eng, a founder covering two roles. Model each seat as its own Principal (so each keeps its own `reports_to` and team memberships) and link them with `same_occupant_as` — an id-shaped pointer field in the Principal's `data` that projects a `same_occupant_as` graph edge — so the chart knows it's one person, not two. It is a field, not a separately-lifecycled edge: split or re-pair seats by editing the field in place (it versions with the node). Don't collapse two distinct roles into one Principal just because the same person fills them today.",
      },
      {
        policy:
          "Use Intents to model teams, departments, and org units. The Intent's `intent` field names the unit's mandate; `actors` lists the member Principals; `stakeholders` lists the people who care about the unit's outcomes without being on the team.",
      },
      {
        policy:
          "Model load-bearing roles and recurring positions — not every contractor, intern, or one-day visitor. If a seat would be empty in three months, it probably belongs in a sibling Doco or a Reference rather than as a Principal here.",
      },
      {
        policy:
          "Treat each Principal as a seat — a role plus its current occupant — not just a person. A budgeted-but-unfilled seat is a valid Principal: declare it `vacant` in `body_md`, name the role it's budgeted for, and keep its `reports_to` line so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure (the same mistake as leaving vacant boxes off a printed chart).",
      },
      {
        policy:
          "Person vs agent isn't about who signed in — it's about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.",
      },
      {
        policy:
          "Seats persist across routine turnover: when one person leaves and another fills the same seat — or a seat goes vacant and is later refilled by the same kind of occupant — keep the Principal, update `body_md`, and record the change as a Decision, so the `reports_to` line and team memberships stay intact and the seat's history reads continuously. Only when the seat's *nature* flips between person and AI agent do you retire the old Principal and create a new one: person-vs-agent is part of the seat's identity in this Doco, and flipping it via a body_md edit erases the prior occupant's history.",
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
