/**
 * Default Doco templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships curated templates describing common Doco shapes
 * such as business processes and synced GitHub pull requests. Template
 * names are plain handles.
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
import { DECISION_RECORD_TEMPLATES } from "./decision-record-templates.js";

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

/**
 * Process fires its completeness + shape policies on the two
 * *committed* lifecycle stages — `queued` (ready, awaiting activation) and
 * `active` (in force) — and exempts only `drafting`.
 *
 * Rationale (the `queued` stage): the node lifecycle is now
 * `drafting → queued → active → retired`. A node an author has explicitly
 * `queue`d is asserting it is ready to go live, so it must already satisfy
 * the same actor attribution (an `attributed_to` edge to a Principal) and
 * process membership (a `has_parent` edge to its process Action) an `active`
 * node does — otherwise "ready" is a lie the BPMN renderer can't draw. Only a
 * `drafting` sketch may be incomplete.
 *
 * This is scoped to process on purpose: it is the one template
 * that defaults new nodes to `drafting` and carries a real
 * draft → queue → activate authoring story. A template that defaults new
 * nodes straight to `active` would rarely pass through `queued`, and would
 * fire its gates on `["active"]` instead.
 *
 * This covers BOTH the completeness/shape gates and the actor-attribution
 * gate (a committed Action or gateway Decision is attributed to a Principal).
 * All of them fire on the committed stages only, so a `drafting` sketch may be
 * both incomplete AND unowned while the author iterates — and is held to the
 * full bar once it is committed. (`retired` is excluded too: a winding-down
 * node isn't re-judged, and the runner's terminal-skip drops these
 * `requires_edge` checks anyway.)
 */
const BUSINESS_PROCESS_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * The glossary template, like process, defaults new terms to `drafting` so a
 * headword can be captured before it is fully defined, and fires its
 * completeness + quality gates on the two committed stages — `queued` (ready
 * for review) and `active` (the approved, in-force definition). A `drafting`
 * stub may be a bare headword with no definition yet; once a term is committed
 * it must carry its meaning and read as a real dictionary entry.
 */
const GLOSSARY_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

export const DEFAULT_DOCO_TEMPLATES: DocoTemplate[] = [
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
    label: "Processes",
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
        // Actor attribution — one gate covering BOTH Actions and gateway
        // Decisions. Fires on the committed stages only (see
        // BUSINESS_PROCESS_COMMITTED_LIFECYCLES): a `drafting` Action or gateway
        // may be sketched without an actor, but a committed one names the
        // Principal accountable for it. With edge roles gone, an `attributed_to`
        // edge to a Principal IS that link — for an Action the performer, for a
        // gateway Decision the decider — distinguished by the source node type.
        // States are milestones and do not act, so they are excluded. Authors
        // create the node and its `attributed_to` edge together in one changeset.
        policy:
          "Every committed (`queued` or `active`) Action and gateway Decision in process is attributed to the Principal accountable for it — an `attributed_to` edge from the node to that Principal. For an Action that Principal performs the step; for a gateway Decision that Principal is the decider answerable for the call. A `drafting` sketch may defer this; a committed Action or gateway with no attributed Principal floats into the BPMN Unassigned lane.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["action", "decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Process membership — one rule for all three flow-node types. A flow
        // node belongs to a process through a `has_parent` edge to the process
        // Action; that edge IS its BPMN pool membership. A hard block once
        // committed: an unattached step has no pool. Two structural exemptions
        // excuse a node that legitimately has no parent: a top-level process
        // Action (`exempt_when_incoming_edge_type: has_parent` — the root, the
        // TARGET of its children's `has_parent`), and an Action explicitly
        // catalogued as an entry point (`exempt_when_field_truthy: entry_point`,
        // a flag in the node's `extra`), which stands on its own as a way into
        // the work and so needs no parent process.
        policy:
          "Every committed (`queued` or `active`) flow node in process — Action, gateway Decision, or milestone/event State — links to the process it belongs to with a `has_parent` edge to that process Action. Without it the BPMN renderer can't place the node in a pool. A top-level process Action (the target of its members' `has_parent`) is the root and is exempt, as is an Action explicitly catalogued as an entry point (an `entry_point` flag in its `extra`); a `drafting` sketch may defer the link.",
        predicate: {
          kind: "requires_edge",
          edge_type: "has_parent",
          target_node_type: "action",
          // The required relationship is the flow node's OUTGOING `has_parent` to
          // its parent process Action. Stated explicitly so the rendered policy
          // is unambiguous next to the incoming-edge exemption just below, which
          // fires the other way (for a node that is itself a parent).
          direction: "outgoing",
          // A process Action (the target of incoming `has_parent` children) is a
          // pool, not a member — it needs no parent of its own.
          exempt_when_incoming_edge_type: "has_parent",
          // An Action explicitly catalogued as an entry point (an `entry_point`
          // flag in its `extra`) stands on its own and needs no parent process.
          exempt_when_field_truthy: "entry_point",
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
      // ── State shape & sequence wiring ───────────────────────────
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
        // State summary as milestone/condition — noun or past-participle
        // naming the milestone.
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `state`. PASS when the text reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`, `awaiting-review`). FAIL with reason if it reads as an imperative verb naming an Action (`Approve invoice`, `Process the order`).",
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
          "BPMN vocabulary — an edge's meaning comes from its type plus the node types it connects, not from any role tag: `flows_to` is process order and renders source -> target with no reversal; a `has_parent` edge from a flow node to a process Action places it in that process's pool (and makes the parent Action a process, or a subprocess if it has a parent of its own); an `attributed_to` edge to a Principal drives actor lanes (from an Action), gateway deciders (from a Decision), and process ownership (from the process Action); a `constrained_by` edge to a Rule links a policy guard; a `supports` edge from an Eval tests the node it points at, and `supports` edges from other nodes carry rationale and evidence.",
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
          "Use `queued` for a process — or a single step, gateway, or milestone — that is fully wired and ready but not yet in force: a redesign awaiting sign-off, a step pending a scheduled go-live, or an approved-but-not-yet-rolled-out change. A `queued` node asserts readiness, so it must already satisfy the same actor attribution, `has_parent` process membership, and forward-flow wiring an `active` node does. If it is still being sketched and that wiring is incomplete, leave it `drafting` instead of queuing it.",
      },
      {
        policy:
          "Process *instances* (recorded runs) live in a separate Doco as Logs; surface them here only via References. This template describes the design of the process, not the history of its executions.",
      },
      {
        policy:
          "Don't model every click, method call, or DB mutation — only the steps that mean something to a business operator. Implementation detail belongs in `apis` or code Docos, not here.",
      },
    ],
  },
  {
    // A shared vocabulary — a controlled set of terms, each defined once.
    // Grounded in terminology-management practice (ISO 704 / 1087): a glossary
    // is concept-oriented (one entry per concept, not per word), every concept
    // has a single preferred headword and a concise, substitutable definition,
    // synonyms and deprecated variants hang off that one entry, and related
    // concepts are cross-referenced rather than re-defined.
    //
    // The Doco shape that carries this: each term is a Reference — its `prose`
    // is the headword (the bare word being defined) and its `definition`
    // attribute is the meaning, so the node's name stays the term and never
    // swallows its definition. A term cites its source inline in `locator` (a
    // URL, standard number, or doc id — provenance is a property of the entry,
    // not a separate node); `alternatives` hold synonyms / deprecated forms.
    // Stewards are Principals. Terms are wired with `relates_to` (see-also),
    // `has_parent` (a narrower term under its broader term or category),
    // `replaces` (a preferred term supersedes a deprecated one), and
    // `attributed_to` (the steward who owns the term). The four-stage lifecycle
    // IS the governance flow: `drafting` (proposed) → `queued` (in review) →
    // `active` (approved, in force) → `retired` (deprecated).
    name: "glossary",
    label: "Glossary",
    icon: "📖",
    description:
      "Define a shared vocabulary — one canonical term per entry, each with a concise definition, synonyms, related terms, and a stewarding owner. Grounded in terminology-management practice (ISO 704 / 1087).",
    defaultNodeLifecycle: "drafting",
    // Open a new glossary directly on the dictionary reading (headwords,
    // definitions, A–Z index). Graph + list defaults sit behind it.
    perspectives: [{ slug: "glossary", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Soft semantic gate — a `warn`, not a block. The author opted into the
        // glossary; this only surfaces "this isn't really a defined term" so
        // they can reconsider. Principals (stewards) are exempt — they aren't
        // headwords — by omitting them from `when_node_type`.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in a glossary when it defines exactly one term. Each Reference is one entry: its prose is the headword (the word being defined) and its `definition` gives the meaning. PASS when the candidate names and defines a single concept a reader of this domain would look up. FAIL only when it bundles several unrelated terms into one entry, is a passing note, task, or decision record rather than a definable term, or carries no definable concept at all.",
          when_node_type: ["reference"],
        },
      },
      {
        // Deterministic node-type allowlist. A glossary is terms + the people
        // who steward them: Reference (the term entries) and Principal (the
        // stewards). Everything else — a process step, a decision record, a
        // free-form note — belongs in its own Doco.
        policy:
          "Only Reference and Principal belong in a glossary. Each term is a Reference — its prose is the headword and its `definition` carries the meaning; Principals are the stewards who own terms. A process step, decision record, or free-form note belongs in its own Doco.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["reference", "principal"],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist). A
        // glossary wires cross-references and term relationships only.
        policy:
          "Only these edge types may be used in a glossary: `relates_to` (see-also between related terms), `has_parent` (place a narrower term under its broader term or category), `replaces` (a preferred term supersedes a deprecated one), and `attributed_to` (name the Principal who stewards the term). A term cites its source inline in its `locator`, not via an edge.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: ["relates_to", "has_parent", "replaces", "attributed_to"],
        },
      },

      // ── Term completeness & quality ─────────────────────────────
      {
        // Completeness floor — fires on the committed stages only
        // (GLOSSARY_COMMITTED_LIFECYCLES): a `drafting` stub may be a bare
        // headword, but a committed term must carry its meaning in `definition`.
        // A headword with no definition is not yet an entry. (`definition` lives
        // in the node's `extra` bag, which the evaluator reads as a field.)
        policy:
          "Every committed (`queued` or `active`) term carries a `definition` — a headword with no meaning is not yet an entry. A `drafting` stub may capture the word first and fill in the definition later.",
        predicate: {
          kind: "requires_field",
          fields: ["definition"],
          when_node_type: ["reference"],
        },
        fires_when_node_lifecycle: GLOSSARY_COMMITTED_LIFECYCLES,
      },
      {
        // Definition quality — LLM-judged, so a `warn`, not a block (an
        // identical retry could differ; a warn nudges without trapping the
        // author). Encodes the intensional-definition rule: concise,
        // substitutable, plain-language, non-circular.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the term's `definition`. PASS when it is a concise, self-contained explanation of the concept (roughly one to three sentences) in plain language: it states what the concept *is* — its category and what distinguishes it — and could stand in for the headword in a sentence. FAIL with a reason when the definition is circular (it defines the term using the term itself), is merely an example or a bare synonym rather than an explanation, is empty or a placeholder, or rambles well beyond a few sentences.",
          when_node_type: ["reference"],
        },
        fires_when_node_lifecycle: GLOSSARY_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "Keep one entry per concept. Give each concept a single canonical entry under its preferred term, and do not create a second entry for the same idea. When two words mean the same thing, keep the preferred one as the entry and record the others as synonyms on it.",
      },
      {
        policy:
          "Record synonyms and deprecated variants as `alternatives` on the canonical entry, not as separate terms. Each alternative is `{ name, note }` (or `{ name, rejected_because }` to mark a form readers should stop using), so a reader who looks up a synonym still lands on the one real definition.",
      },
      {
        policy:
          "Keep the headword bare: put only the term in the prose and the meaning in `definition`. Don't restate the term inside its own definition (no circular definitions), and don't fold the part of speech, pronunciation, or source into the headword.",
      },
      {
        policy:
          "Cross-reference related concepts with `relates_to`, and place a narrower term under its broader term or category with `has_parent`, so the glossary reads as a connected vocabulary rather than a flat list of isolated words.",
      },
      {
        policy:
          "When a new preferred term replaces an old one, retire the old entry (lifecycle `retired`) and link the new term to it with a `replaces` edge (the `supersede` changeset op creates the replacement and the edge together), so a reader who looks up the old word is redirected to the current term instead of finding two live definitions.",
      },
      {
        policy:
          "Cite where a definition comes from when it is drawn from an external standard, contract, or document: put the citation in the term's own `locator` (a URL, standard number, or document id). Source provenance is a property of the entry, not a separate node.",
      },
      {
        policy:
          "Name a steward by attributing a term — or the glossary's anchor terms — to a Principal with an `attributed_to` edge, so there is a clear owner accountable for reviewing and approving changes. A glossary is a living document; it needs someone to keep it current.",
      },
      {
        policy:
          "Walk a term through the lifecycle as it matures: `drafting` while you are still capturing or wording it, `queued` once it is ready for review, `active` when it is the approved, in-force definition, and `retired` when it is deprecated or superseded. Completeness and quality rules apply once a term is committed (`queued` or `active`); a `drafting` stub may be incomplete.",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write entries with `POST /<handle>/api/changesets.json` — create each term as a Reference with its `definition` (and any `alternatives`, plus a `locator` when citing a source), and add its `relates_to` / `has_parent` / `attributed_to` edges in the same changeset rather than as disconnected nodes.",
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
    // Org chart — document an organization's STRUCTURE: who holds which
    // seat, who reports to whom, how seats group into teams, and where
    // decision authority sits. It renders on the org-tree perspective, which
    // draws each Principal as a seat and each `has_parent` edge between two
    // seats as a solid reporting line, with person / AI agent / vacant shown
    // by icon.
    //
    // The shape distills the durable best practices for documenting org
    // charts onto Doco's primitives:
    //   - A box is a SEAT (a role), not a person. Name the Principal by its
    //     role and record the occupant (human / AI agent / vacant) separately,
    //     so a hire or departure updates one seat instead of redrawing the
    //     chart.
    //   - UNITY OF COMMAND: one solid reporting line per seat — a single
    //     `has_parent` edge to its manager — so the primary hierarchy stays a
    //     clean tree (enforced by a `limits_edge` cap).
    //   - DOTTED-LINE / MATRIX coordination is influence without authority: a
    //     `relates_to` edge from a seat to its secondary manager, which the
    //     org-tree perspective layers over the solid tree as a dashed line.
    //   - SINGLE POINT OF ACCOUNTABILITY: a decision right is a Decision with
    //     exactly one accountable seat (`attributed_to` → Principal).
    //   - TEAMS / DEPARTMENTS are Intents the seats belong to (`attributed_to`),
    //     which is how a functional, divisional, or matrixed structure reads.
    //
    // Lifecycle: nodes default to `active` (there is no draft → queue → activate
    // workflow). An org chart documents a structure that already exists, so a
    // seat and its lines are held to the template's shape as soon as they are
    // captured — hence the structural gates carry no lifecycle filter.
    name: "org-chart",
    label: "Org chart",
    icon: "🏢",
    description:
      "Document who reports to whom — seats as roles, a single solid reporting line per seat, teams, dotted-line coordination, and decision authority. Renders as an org tree.",
    // Open a freshly-created org-chart Doco directly on the org-tree view,
    // where the reporting hierarchy this template authors is most legible.
    // Graph + list defaults stay attached behind it.
    perspectives: [{ slug: "org-tree", isDefault: true }],
    policies: [
      // ── Membership (soft semantic gate) ──────────────────────────────
      {
        // Warn, not block: the author opted into the org-chart template, so
        // this only surfaces "this looks like work/process content, not org
        // structure" for reconsideration. Rules govern the chart rather than
        // being chart content, so they are exempt (omitted from
        // `when_node_type`).
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in an org chart when it documents organizational STRUCTURE: a seat / role (Principal), a team or department (Intent), a decision right or accountability (Decision), or a supporting role charter / job description (Reference). Pass when the candidate is one of these. Fail when it instead describes how WORK flows — a process step, a task, a product feature, an event, or a one-off incident — which belongs in a process Doco, not here.",
          when_node_type: ["principal", "intent", "decision", "reference"],
        },
      },

      // ── Seat occupant declaration (soft) ─────────────────────────────
      {
        // Warn: the org-tree perspective needs to know whether a seat is held
        // by a person, an AI agent, or is vacant, to draw the right marker
        // (👤 / 🤖 / 🪑). Surfaced, not enforced, so a seat can be captured
        // before its occupant is settled.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: 'Every seat (Principal) declares who fills it so the chart can draw the right marker. Set the seat\'s `kind` to `human` for a person or `agent` for an AI agent; or, if the seat is budgeted but unfilled, say so in its `prose` (e.g. "Vacant — open req for a Staff Engineer"). Pass when the occupant kind — person, AI agent, or vacant — is unambiguous; fail when a seat leaves it unstated.',
          when_node_type: ["principal"],
        },
      },

      // ── Node-type allowlist (hard block) ─────────────────────────────
      {
        policy:
          "Only Principal, Intent, Decision, Reference, and Rule belong in an org chart. A Principal is a seat (a role); an Intent is a team or department that seats belong to; a Decision records a decision right and its accountable seat; a Reference attaches a role charter or job description; a Rule states a governance constraint. Process steps (Action), milestones (State), and tests (Eval) describe how work flows — they belong in a process Doco, not an org chart.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["principal", "intent", "decision", "reference", "rule"],
        },
      },

      // ── Edge-type allowlist (hard block) ─────────────────────────────
      {
        policy:
          "Only these relationship edge types belong in an org chart: `has_parent` (the solid reporting line, and a seat's membership in a team), `attributed_to` (a seat's team, or a Decision's single accountable seat), `relates_to` (dotted-line / matrix coordination — influence without authority), `supports`, `replaces`, and `derived_from`. Process-flow edges (`flows_to`) and guard edges (`constrained_by`) model how work runs and don't belong here.",
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

      // ── Unity of command (hard block) ────────────────────────────────
      {
        policy:
          "Unity of command: each seat reports to at most one manager — a single `has_parent` edge (its solid line). A seat with two `has_parent` parents is no longer a tree; model the secondary relationship as a dotted line (`relates_to`) instead, so accountability stays unambiguous.",
        predicate: {
          kind: "limits_edge",
          edge_type: "has_parent",
          target_node_type: "principal",
          max_count: 1,
          when_node_type: ["principal"],
        },
      },

      // ── Guidance (prose-only suggestions) ────────────────────────────
      {
        policy:
          'Positions define the structure, not the people who fill them. Name each seat (Principal) by its role or title — "Head of Engineering", not "Dana Lee" — and record the current occupant in its `prose`. That way a hire, departure, or transfer updates one seat instead of forcing the chart to be redrawn.',
      },
      {
        policy:
          'Give every seat exactly one solid reporting line: a `has_parent` edge from the report to its manager, which the org-tree perspective draws as the solid hierarchy. A seat with no manager is top-of-chain — say so in its `prose` (e.g. "Top of chain — reports to the board") so its rootedness reads as deliberate, not missing.',
      },
      {
        policy:
          "Group seats into teams or departments: model each team as an Intent and link its members with `attributed_to` edges from the seat to the team. This is how a functional, divisional, or matrixed structure shows up without overloading the single reporting line each seat already has.",
      },
      {
        policy:
          "Record decision rights as Decision nodes with a single accountable seat — one `attributed_to` edge to the Principal who is Accountable (RACI's single point of accountability). Name the escalation path in the Decision's `prose` when the call can be escalated above that seat.",
      },
      {
        policy:
          "Model dotted-line / matrix relationships with `relates_to`, drawn from the seat to its secondary manager: influence and coordination without formal authority (e.g. a regional lead who coordinates with a global function). The org-tree perspective renders these dashed, layered over the solid tree — keep the solid `has_parent` line for the one primary manager.",
      },
      {
        policy:
          'Mark unfilled seats vacant rather than deleting them. A budgeted-but-open role is part of the structure and matters for headcount and succession planning; say "Vacant" (and what you are hiring for) in the seat\'s `prose`. The org-tree perspective draws a vacant seat with its own marker (🪑).',
      },
      {
        policy:
          "The chart shows the shape; written role scope carries the detail. Attach a Reference (job description or team charter) describing a seat's responsibilities and decision authority, linked with `supports`, rather than packing all of it into the seat's `prose`.",
      },
      {
        policy:
          "Keep the chart current: update it after every reorganization, hire, departure, and role change. When a seat's occupant changes, update its `prose`; when reporting lines move, retire the old `has_parent` edge and add the new one. An org chart is only useful while it is accurate.",
      },
    ],
  },
  // The four decision-record templates (ADR, product, design, data) share one
  // core and live in their own module; see `decision-record-templates.ts`.
  ...DECISION_RECORD_TEMPLATES,
];

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored under plain handles (`process`,
 * `github-pull-requests`).
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
