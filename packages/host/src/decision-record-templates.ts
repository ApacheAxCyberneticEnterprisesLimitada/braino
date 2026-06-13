/**
 * Decision-record templates — Architectural (ADR), Product, and Design.
 *
 * All three document the SAME thing in three domains: a decision, its context
 * and rationale, the options weighed, who is accountable, and the forces that
 * drove it — kept as an append-only log so a future reader can tell *why* the
 * call was made and whether it still holds. Industry practice (Nygard ADRs,
 * MADR, product decision records, design decision records) converges on one
 * record shape:
 *
 *   question → considered options (+ why rejected) → chosen + rationale,
 *   with a status that moves Proposed → Accepted → Superseded, the people
 *   accountable, the drivers/criteria, the evidence, and supersession (never
 *   edit an accepted record — replace it and link the two).
 *
 * That shape already IS the `decision` node: `question`, `alternatives`
 * (`{name, rejected_because}`), `chosen` (null while drafting), `decision`
 * (the rationale prose), `decided_at`, plus the shared `lifecycle`. So the
 * three templates need NO new node type — they cultivate the existing Decision
 * and map the universal status onto the node lifecycle:
 *
 *   drafting = draft / RFC (the choice may still be open, `chosen` may be empty)
 *   queued   = proposed   (fully formed, awaiting sign-off)
 *   active   = accepted   (in force)
 *   retired  = deprecated / superseded (the replacement carries a `replaces` edge)
 *
 * The three share ONE core (`decisionRecordCore`) and differ only in a
 * domain-fit gate plus a few lines of domain guidance (`FLAVORS`). Adding a
 * fourth decision flavor is one `FLAVORS` entry — there is deliberately no
 * fourth copy of the core policy list to keep in sync. Data-modeling, storage,
 * and governance decisions are recorded as ADRs — the architectural flavor
 * subsumes them rather than carrying a separate data log.
 */
import type { Lifecycle } from "@doco/shared";
import type { DocoTemplate, TemplatePolicy } from "./doco-templates.js";

/**
 * A decision record fires its completeness gates on the two *committed* stages —
 * `queued` (proposed, awaiting sign-off) and `active` (accepted, in force) — and
 * exempts `drafting`. A proposed decision is asserting it is ready to accept, so
 * it must already name its `chosen` option and the Principal accountable for it;
 * only a `drafting` sketch may leave the choice open and the decider unnamed.
 * (Mirrors the process template's committed-lifecycle gating.)
 */
const DECISION_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * The policies every decision-record Doco shares, regardless of domain. The
 * domain templates append their fit gate and domain guidance to this list.
 */
function decisionRecordCore(): TemplatePolicy[] {
  return [
    // ── Membership: node + edge allowlists (deterministic, block) ───────────
    {
      // A decision record is the Decisions themselves plus the supporting cast
      // that gives each one meaning: the Principals accountable for it, the
      // Rules that captured its drivers/criteria, the Evals that confirm it, and
      // the References that supply context. Flow nodes (Action/State) belong in a
      // process Doco, not here.
      policy:
        "Only Decision, Principal, Rule, Eval, and Reference belong in a decision record. A Decision is the record itself (its question, the options considered, the chosen path, and the rationale). Principals are who decided and who is accountable; Rules capture the decision drivers and criteria; Evals confirm or validate a decision; References supply context and link out to the artifacts a decision concerns. Actions, States, and other flow nodes belong in a process Doco.",
      predicate: {
        kind: "requires_node_type",
        node_types: ["decision", "principal", "rule", "eval", "reference"],
      },
    },
    {
      // The edge analogue of the node allowlist. A decision record is a web of
      // decisions joined by attribution, drivers, evidence, supersession, and
      // see-also links — never sequence flow or pool membership.
      policy:
        "Only these relationship edge types may be used in a decision record: `attributed_to` (a Decision → the Principal who decided or is accountable), `constrained_by` (a Decision → a Rule that drove it), `supports` (an Eval or Reference → the Decision it confirms or informs), `replaces` (a new Decision → the one it supersedes), `derived_from` (provenance from a prior decision or source), and `relates_to` (a see-also link between related decisions). Sequence flow (`flows_to`) and pool membership (`has_parent`) belong in a process Doco.",
      predicate: {
        kind: "requires_edge_type",
        edge_types: [
          "attributed_to",
          "constrained_by",
          "supports",
          "replaces",
          "derived_from",
          "relates_to",
        ],
      },
    },

    // ── Completeness (deterministic, committed stages only, block) ──────────
    {
      // A proposed/accepted decision has landed on something. Engine-checked via
      // `chosen` presence — `isNonEmpty` treats the `null` a drafting Decision
      // carries as missing, so this fires only once the record is committed.
      policy:
        "A committed (proposed or accepted) Decision names its `chosen` option — the path it lands on. A `drafting` decision may leave `chosen` empty while the choice is still open.",
      predicate: {
        kind: "requires_field",
        fields: ["chosen"],
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: DECISION_COMMITTED_LIFECYCLES,
    },
    {
      // Accountability. Every committed decision names who made it / who owns it,
      // via an `attributed_to` edge to a Principal — the analogue of the process
      // gateway-decider gate. A drafting decision may defer naming the decider.
      policy:
        "A committed (proposed or accepted) Decision is attributed to the Principal who made it or is accountable for it — an `attributed_to` edge from the Decision to that Principal. A `drafting` decision may defer naming the decider.",
      predicate: {
        kind: "requires_edge",
        edge_type: "attributed_to",
        target_node_type: "principal",
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: DECISION_COMMITTED_LIFECYCLES,
    },
    {
      // The CEILING that complements the accountability FLOOR above: a committed
      // Decision is attributed to AT MOST one Principal — its single accountable
      // owner (the decider who made it / who owns it). A record attributed to two
      // Principals is ambiguous about who is answerable for the call. A `drafting`
      // decision may defer or over-attach while it is still being shaped. (Mirrors
      // the process template's gateway-decider attribution cap.)
      policy:
        "A committed (proposed or accepted) Decision is attributed to AT MOST one Principal — the single decider who made it or is accountable for it. It carries at most one `attributed_to` edge to a Principal; two named deciders leaves accountability ambiguous. A `drafting` decision may defer naming the decider.",
      predicate: {
        kind: "limits_edge",
        edge_type: "attributed_to",
        target_node_type: "principal",
        max_count: 1,
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: DECISION_COMMITTED_LIFECYCLES,
    },

    // ── Record quality (probabilistic, LLM-judged, warn, committed only) ────
    // Warnings, not blocks: an LLM verdict is non-deterministic, so a block both
    // traps legitimate records and can flip on retry. These surface the gaps that
    // make a record useless later without standing between the author and a save.
    // They fire only on the committed stages (queued/active), like the
    // deterministic completeness gates: a `drafting` sketch is a work in progress
    // and shouldn't be nagged about incomplete rationale or unlisted options. (The
    // domain-fit nudge below is the exception — it fires on every stage so an
    // author is steered to the right decision log early.)
    {
      on_violation: "warn",
      predicate: {
        kind: "probabilistic",
        spec: "Check the Decision's `question`. PASS when it poses a genuine decision — a choice to be made, with real alternatives and consequences (e.g. `Which datastore backs the event log?`, `Do we gate signups behind an invite?`). FAIL when it is a vague topic with no choice in it (`Database stuff`), merely restates the chosen answer, or describes a task to perform rather than a decision to make.",
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: DECISION_COMMITTED_LIFECYCLES,
    },
    {
      on_violation: "warn",
      predicate: {
        kind: "probabilistic",
        spec: "Check the Decision's `decision` prose together with `chosen`. PASS when it states BOTH the context that made the decision necessary AND the rationale for the chosen option — why this option over the alternatives. FAIL when it records what was chosen with no reasoning, or describes context with no decision. A record without its justification can't be re-evaluated when the circumstances that drove it change.",
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: DECISION_COMMITTED_LIFECYCLES,
    },
    {
      on_violation: "warn",
      predicate: {
        kind: "probabilistic",
        spec: "Check the Decision's `alternatives`. PASS when the real options that were weighed are listed, each with why it lost (`rejected_because`), OR when the decision genuinely had a single viable path and the prose says so. FAIL when alternatives are omitted on a decision that plainly had them, so a reader can't tell what trade-off was made.",
        when_node_type: ["decision"],
      },
      fires_when_node_lifecycle: DECISION_COMMITTED_LIFECYCLES,
    },

    // ── Status, supersession, drivers, evidence (prose guidance) ────────────
    {
      policy:
        "Map a decision's status onto the node lifecycle: `drafting` = a draft or RFC still being explored (the choice may be open); `queued` = proposed and awaiting sign-off (fully formed — it already names its `chosen` option and its decider Principal); `active` = accepted and in force; `retired` = deprecated or superseded. `queue` a decision to propose it, `activate` it once accepted, and `supersede` it (the op creates the replacement and links the two with a `replaces` edge) when a later decision overrides it.",
    },
    {
      policy:
        "A decision record is append-only. When the direction changes, do NOT rewrite an accepted Decision — supersede it: create the new Decision, link it to the old one with a `replaces` edge, and `retire` the old one. This preserves the history of what was decided and why the direction shifted, which is the whole point of keeping the log.",
    },
    {
      policy:
        "Capture the forces that drove a decision — its drivers, criteria, and constraints — as Rules, and link each to the Decision with a `constrained_by` edge. Making the drivers explicit lets a reader judge whether they still hold, which is what tells you when a decision is due to be revisited.",
    },
    {
      policy:
        "Confirm a decision with an Eval linked by `supports` — the check, test, or measure that tells you whether the decision is holding up. Link the context a decision concerns — specs, components, mockups, data sources, external docs — as References, also via `supports`.",
    },
    {
      policy:
        "Capture exactly one decision per Decision node. A record that bundles several choices can't be superseded, re-evaluated, or linked cleanly. Split a compound decision into separate records and connect them with `relates_to`.",
    },
    {
      policy:
        "Agents should read `GET /<handle>/api/authoring-contract.json` and write with `POST /<handle>/api/changesets.json`, creating each Decision together with its `attributed_to`, `constrained_by`, and `supports` edges in the same changeset rather than as disconnected nodes.",
    },
  ];
}

/**
 * One decision-record domain: its identity, the LLM-judged fit gate that nudges
 * authors when a record belongs in a *different* decision log, and the handful of
 * domain-specific guidance lines appended to the shared core.
 */
interface DecisionFlavor {
  name: string;
  label: string;
  icon: string;
  description: string;
  /** The `spec` for the domain-fit probabilistic gate (warn). */
  fitSpec: string;
  /** Domain-specific prose guidance appended after the core. */
  guidance: string[];
}

const FLAVORS: DecisionFlavor[] = [
  {
    name: "architectural-decisions",
    label: "Architectural decisions (ADR)",
    icon: "🏛️",
    description:
      "Record architecturally significant decisions (ADRs) — system structure, technology choices, and how data is modeled, stored, and governed — as an append-only log of the context, the options weighed, the choice, and its consequences.",
    fitSpec:
      "Check the Decision. PASS when it records an architecturally significant choice — one that shapes system structure or runtime topology, selects a core technology or the datastore an application runs on, affects a quality attribute (scalability, performance, security, reliability, maintainability), spans components, or is costly to reverse. This includes how data is structured and governed within the system: the data model, schema, or grain; the storage format, partitioning, or layout of a dataset; pipelines and transformations; the source of truth; data lineage; and retention, privacy, or governance rules. FAIL when it is a routine, local coding choice with no structural or cross-cutting impact, or a non-technical product or design decision — record those in their own logs.",
    guidance: [
      "An ADR's decision drivers are its architecturally significant requirements — the quality attributes and constraints it must satisfy (a latency budget, a compliance rule, team skills, cost). Capture each as a Rule linked by `constrained_by`.",
      "Spell out the technical consequences in the `decision` prose, including what becomes harder: the new constraints, the operational burden, and the technical debt the choice deliberately takes on.",
      "Reference the components, services, and external standards an ADR governs so the record sits next to the architecture it concerns.",
      "Name the migration, backfill, or cutover a decision requires — the operational path to adopt it — in the `decision` prose, so the record carries not just the choice but how the system gets there.",
      "When a decision concerns data, make its data dimension explicit: the grain and source of truth it establishes (what one row or record represents, and which system owns it), the lineage it affects, and its governance impact — privacy classification, retention, and access. Capture data contracts, SLAs, and quality thresholds as Rules via `constrained_by`, and the data-quality checks that enforce them as Evals via `supports`.",
    ],
  },
  {
    name: "product-decisions",
    label: "Product decisions",
    icon: "🧭",
    description:
      "Record product decisions — what to build and why, for which users, with the expected impact — and revisit them when the context changes.",
    fitSpec:
      "Check the Decision. PASS when it records a product choice — what to build (or not build), for which users, and why — tied to a user problem or a business goal. FAIL when it is a pure engineering or implementation choice with no product rationale (record that as an architectural decision instead).",
    guidance: [
      "State the user problem and business goal the decision serves — capture it as a Rule (the decision driver) via `constrained_by`, or link the brief/research as a Reference via `supports`.",
      "Name the success metric and how it will be validated as an Eval linked by `supports`, so the decision can be judged against its expected impact, not just its intent.",
      "Every product decision is made in a context that will change. Note the review trigger in the prose — the date, assumption, or threshold that should prompt revisiting it — and supersede the record when that trigger fires.",
    ],
  },
  {
    name: "design-decisions",
    label: "Design decisions",
    icon: "🎨",
    description:
      "Record design decisions — UX, interaction, and visual choices — grounded in user needs, evidence, and design principles.",
    fitSpec:
      "Check the Decision. PASS when it records a design choice — UX, interaction, information architecture, content, or visual — grounded in user needs and design principles. FAIL when it is a backend or architecture choice with no user-facing surface, or a product-scope decision about what to build (record those in their own logs).",
    guidance: [
      "Ground the rationale in evidence: link the user research, usability test, or experiment that informed the decision as an Eval (`supports`), and the mockups, prototypes, or design specs as References (`supports`).",
      "Capture the design principles and constraints that drove the decision — accessibility requirements, platform conventions, the design system — as Rules via `constrained_by`.",
    ],
  },
];

/** Build one domain template from the shared core plus its flavor. */
function decisionRecordTemplate(flavor: DecisionFlavor): DocoTemplate {
  return {
    name: flavor.name,
    label: flavor.label,
    icon: flavor.icon,
    description: flavor.description,
    // New decisions start as drafts so a record can be sketched freely; the
    // completeness gates fire only once it is proposed (`queued`) or accepted.
    defaultNodeLifecycle: "drafting",
    // A decision log is fundamentally a filterable list of records, so open the
    // overview on the built-in List perspective. (Graph stays attached behind it.)
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      ...decisionRecordCore(),
      // ── Domain fit (probabilistic, warn) ──────────────────────────────────
      // A nudge, not a block: the author opted into this log by picking the
      // template, so the gate just surfaces "this looks like a decision for a
      // different log" rather than second-guessing the choice.
      {
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: flavor.fitSpec,
          when_node_type: ["decision"],
        },
      },
      // ── Domain guidance (prose) ───────────────────────────────────────────
      ...flavor.guidance.map((policy): TemplatePolicy => ({ policy })),
    ],
  };
}

/**
 * The three decision-record templates, spread into `DEFAULT_DOCO_TEMPLATES`.
 */
export const DECISION_RECORD_TEMPLATES: DocoTemplate[] = FLAVORS.map(decisionRecordTemplate);
