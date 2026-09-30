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

/**
 * The bug tracker fires its completeness + quality gates on the two committed
 * stages — `queued` (triaged and accepted into the queue to fix) and `active`
 * (confirmed and being worked) — and exempts `drafting`. The node lifecycle IS
 * the bug's status axis: `drafting` = reported/unconfirmed (triage pending, a
 * quick report may be incomplete) → `queued` = triaged & accepted (reproduced,
 * rated, owned) → `active` = confirmed and in force → `retired` = closed. So a
 * raw report can be filed as a bare description without tripping the gates, and
 * is held to the full bar only once it is committed — the same committed-stage
 * gating the process and decision-record templates use. (How a bug *closed* —
 * fixed / duplicate / cannot-reproduce / by-design / won't-fix — is the second,
 * orthogonal disposition axis, carried in a `resolution` field, not lifecycle.)
 */
const BUG_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * The FAQ template, like glossary, defaults new entries to `drafting` so a
 * question can be captured the moment it is asked, and fires its completeness +
 * quality gates on the two committed stages — `queued` (in review) and `active`
 * (the validated, in-force answer). This maps the lifecycle onto the KCS
 * (Knowledge-Centered Service) article state: a `drafting` stub is "work in
 * progress" (the question captured, no validated answer yet), `queued` is in
 * review, `active` is validated/published, and `retired` is archived/superseded.
 * A `drafting` entry may be a bare question; once committed it must carry its
 * answer and its stewarding owner.
 */
const FAQ_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * The AI-eval template, like process and glossary, defaults new nodes to
 * `drafting` so an eval can be sketched and a run captured before either is
 * finalized, and fires its completeness + quality gates on the two committed
 * stages — `queued` (ready for review) and `active` (the in-force eval / a
 * recorded run). A `drafting` Eval may name an intent before its grader is
 * chosen, and a `drafting` Log may be jotted before it is linked to its eval;
 * once committed, an Eval must declare how it grades and a run must link to the
 * Eval it ran.
 */
const EVALS_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * The product-roadmap template, like the decision-record and glossary
 * templates, fires its completeness gates on the two *committed* stages —
 * `queued` (planned / Next) and `active` (in progress / Now) — and exempts
 * `drafting`, a parked / Later idea still being shaped. A committed item asserts
 * it is on the roadmap, so it must already name the Principal accountable for
 * its outcome and the Now/Next/Later `horizon` it sits in; only a `drafting`
 * parking-lot idea may defer both. The result Eval is held to the same bar: a
 * committed result links the item it measures.
 */
const ROADMAP_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * Test scenarios, like process and glossary, default new scenarios to
 * `drafting` so a test can be sketched before its steps and expected result are
 * written, and fire their completeness + quality gates on the two committed
 * stages — `queued` (ready to run or review) and `active` (approved, in the
 * suite). A `drafting` sketch may be a bare idea with no steps yet; once a
 * scenario is committed it must say how to run it and judge against one
 * observable expected result. (Runs — Logs — are facts recorded as `active`.)
 */
const TEST_SCENARIO_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

/**
 * The ideas template, like bugs and FAQ, defaults new nodes to `drafting` so an
 * idea can be jotted the instant it occurs — the inbox is sacred and a capture
 * is never blocked — and fires its completeness + quality gates on the two
 * committed stages: `queued` (triaged — deduped, its problem framed, a shepherd
 * named) and `active` (in evaluation — being scored, validated, championed). A
 * `drafting` jot may be a bare one-liner; once a team commits attention to an
 * idea it must say what problem it solves and who is moving it. (`retired` is
 * the closed stage — promoted or rejected — and is not re-judged.)
 */
const IDEA_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

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
        // The CEILING that complements the actor-attribution FLOOR above: a
        // committed Action or gateway Decision is attributed to AT MOST one
        // Principal, so it has exactly one accountable owner — the performer of
        // the step or the decider answerable for the call. A node attributed to
        // two Principals is ambiguous: the BPMN renderer places it in a single
        // actor lane (it reads only the first `attributed_to` edge) and silently
        // drops the rest, so the second owner vanishes from the swimlanes
        // unnoticed. A `drafting` sketch is exempt. Re-point by retiring the old
        // `attributed_to` edge before adding the new one; endpoints are immutable.
        // (The mirror of the `has_parent` membership ceiling below.)
        policy:
          "Every committed (`queued` or `active`) Action and gateway Decision in process is attributed to AT MOST one Principal — its single accountable owner (the Action's performer or the gateway's decider). It carries at most one `attributed_to` edge to a Principal. A node attributed to two Principals is ambiguous: the BPMN renderer can place it in only one actor lane. A `drafting` sketch is exempt. Re-point by retiring the old `attributed_to` edge before adding the new one.",
        predicate: {
          kind: "limits_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          max_count: 1,
          when_node_type: ["action", "decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Process membership — one rule for all three flow-node types. A flow
        // node belongs to a process through an OUTGOING `has_parent` edge to the
        // process Action; that edge IS its BPMN pool membership. A hard block
        // once committed: an unattached step has no pool. The ONLY exemption is
        // an explicit `top_level` flag (a boolean in the node's `extra`):
        // a top-level Action is the root pool and has no parent of its
        // own. (There is no structural incoming-edge exemption — being pointed at
        // by children does not, by itself, excuse a node from declaring its own
        // parent; the author marks the root explicitly instead.)
        policy:
          "Every committed (`queued` or `active`) flow node in process — Action, gateway Decision, or milestone/event State — links to the process it belongs to with a `has_parent` edge to that process Action. Without it the BPMN renderer can't place the node in a pool. The only exception is a top-level Action, which the author marks with a `top_level` flag (a boolean in its `extra`); a `drafting` sketch may defer the link.",
        predicate: {
          kind: "requires_edge",
          edge_type: "has_parent",
          target_node_type: "action",
          // The required relationship is the flow node's OUTGOING `has_parent` to
          // its parent process Action. Stated explicitly so the rendered policy
          // is unambiguous.
          direction: "outgoing",
          // A top-level Action is the root pool and has no parent of its
          // own, so it is excused — but only when the author marks it explicitly.
          exempt_when_field_truthy: "top_level",
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
        // Sequence-flow REACHABILITY floor: a committed flow node is reached by
        // the flow — it has ≥1 INCOMING `flows_to` — unless the author has flagged
        // it an `entry_point` (a way into the process, which by definition has no
        // predecessor). Keeps a committed process free of orphaned, unreachable
        // steps. A `drafting` sketch may dangle.
        policy:
          "Every committed (`queued` or `active`) flow node in process is reached by the flow: it has at least one incoming `flows_to` edge — unless it is marked as an entry point (an `entry_point` flag in its `extra`), which is a way into the process and so needs no predecessor. A `drafting` sketch may be unreachable while you wire it up.",
        predicate: {
          kind: "requires_edge",
          edge_type: "flows_to",
          direction: "incoming",
          // An entry point is the start of the flow (no predecessor), and a
          // top-level Action is the pool container (not a sequenced step) — both
          // are excused from needing an incoming `flows_to`.
          exempt_when_field_truthy: "entry_point, top_level",
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Sequence-flow "leads somewhere" floor — the dual of reachability.
        // Every committed flow node has ≥1 OUTGOING `flows_to` (it leads to a
        // next step), UNLESS it is an `exit_point` (an end of the flow, by
        // definition with no successor) or a `top_level` Action (the pool
        // container, not a sequenced step). A `drafting` sketch may dangle.
        policy:
          "Every committed (`queued` or `active`) flow node in process leads somewhere: it has at least one outgoing `flows_to` edge to a next step — unless it is marked as an exit point (an `exit_point` flag in its `extra`), which is an end of the process and so needs no successor, or it is the top-level pool container. A `drafting` sketch may be incomplete.",
        predicate: {
          kind: "requires_edge",
          edge_type: "flows_to",
          direction: "outgoing",
          // An exit point is the end of the flow (no successor), and a top-level
          // Action is the pool container (not a sequenced step) — both excused.
          exempt_when_field_truthy: "exit_point, top_level",
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
      {
        // Concise name — the process canvas renders a flow node's `prose` as
        // its box label, so a run-on `prose` becomes a run-on name on the
        // diagram. This afflicts ANY flow node (Action, gateway Decision, or
        // milestone State), not just a (sub)process Action: a Decision or
        // State reads just as badly when its label is a whole sentence. So it
        // covers the entire flow-node triad — the same `["action", "decision",
        // "state"]` set the membership/sequence floors use — and fires from
        // the first draft (no `fires_when_node_lifecycle`: there is no
        // lifecycle where a run-on label is wanted, and the nudge is most
        // useful the instant the name is first typed). The non-flow types are
        // deliberately out of scope: a Principal's `prose` carries lane
        // responsibility (the principal-lane policy wants that, not a bare
        // label) and a Rule/Reference `prose` is legitimately long-form.
        // `warn`, not block — it's an LLM-judged style nudge.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the node's `prose` — the process canvas renders it as this flow node's box label. PASS when it reads as a concise label: a verb+object (`publish a job`), a noun phrase, or a milestone phrase (`invoice approved`). FAIL with reason when it is a run-on sentence that strings several steps or conditions together (e.g. `all steps from asking to post a job through to the published job post being confirmed`) or stuffs a paragraph of detail into the name; suggest leading with a short headline and moving the detail into a supporting field or Reference.",
          when_node_type: ["action", "decision", "state"],
        },
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
    // Frequently asked questions — a question-and-answer knowledge base whose
    // entries are kept honest by USE. Grounded in Knowledge-Centered Service
    // (KCS) and help-center practice, which converge on one insight: an FAQ is
    // two linked objects, not one — an improvable Entry and an immutable stream
    // of Usage events ("reuse is review"; usage is the validation signal). The
    // Doco shape that carries this maps both onto existing primitives, so the
    // template needs no new node type:
    //
    //   - Each FAQ entry is a Reference. Its `prose` is the canonical question
    //     in the user's own words (the lookup key, exactly like a glossary
    //     headword); its `answer` (an `extra` field, kept off the prose so the
    //     entry's name stays the bare question) is a concise, answer-first
    //     reply; its `locator` links the single source of truth the answer
    //     digests (cite, don't duplicate — so the answer can't drift out of
    //     sync); and its `alternatives` hold the paraphrases people actually
    //     ask, so a reader — or an agent matching on wording — who phrases it
    //     differently still lands on the one canonical entry. A Principal
    //     stewards it via `attributed_to`.
    //   - Each result is a Log. Its `prose` is the question as actually asked,
    //     `happened_at` is when, and `outcome` records whether the FAQ resolved
    //     it (`succeeded`) or not (`failed`). A resolved result links to the
    //     entry that answered it with a `supports` edge — every use IS a review,
    //     so the Logs that `supports` an entry are its reuse count and its
    //     evidence of health. A result that found NO answer is a gap: an orphan
    //     Log (no `supports` edge) whose raw question is the demand signal for
    //     the next entry to write.
    //
    // Lifecycle: new entries default to `drafting` (FAQ_COMMITTED_LIFECYCLES),
    // so a question can be captured the instant it is asked; the completeness
    // (answer + steward) and quality (question + answer) gates fire only once
    // the entry is committed (`queued`/`active`). A FAQ is fundamentally a
    // filterable list of entries, so it opens on the built-in List perspective.
    name: "faq",
    label: "FAQ",
    icon: "❓",
    description:
      "Document frequently asked questions — one canonical question per entry, a concise answer, the paraphrases people actually ask, a source of truth, and a stewarding owner — and log each result so reuse, gaps, and stale answers surface. Grounded in Knowledge-Centered Service (KCS).",
    defaultNodeLifecycle: "drafting",
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Soft semantic gate — a `warn`, not a block. The author opted into the
        // FAQ; this only surfaces "this isn't really a reusable Q&A" so they can
        // reconsider. Scoped to Reference (the entries): a result Log is a raw
        // recorded question whose text could read like anything, and a Principal
        // is a steward — neither is a membership candidate, so both are omitted
        // from `when_node_type`.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in an FAQ when it captures one recurring question and its reusable answer. Each Reference is one entry: its prose is the question and its `answer` is the reply. PASS when the candidate is a question people ask more than once with an answer worth reusing. FAIL only when it is a one-off note, a decision record, a process step, or a passing remark rather than a question with a reusable answer.",
          when_node_type: ["reference"],
        },
      },
      {
        // Deterministic node-type allowlist. An FAQ is entries + their results +
        // the people who steward them: Reference (the Q&A entries), Log (the
        // recorded results of asking), and Principal (the stewards). Everything
        // else — a process step, a decision record, a free-form idea — belongs
        // in its own Doco.
        policy:
          "Only Reference, Log, and Principal belong in an FAQ. Each entry is a Reference — its prose is the question and its `answer` carries the reply; each result of asking is a Log (with an `outcome` of `succeeded` or `failed`); Principals are the stewards who own entries. A process step, decision record, or free-form note belongs in its own Doco.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["reference", "log", "principal"],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist). An
        // FAQ is a knowledge/association graph, not a process: it wires
        // stewardship, usage evidence, cross-references, topic nesting,
        // supersession, and provenance — never sequence flow (`flows_to`) or
        // policy guards (`constrained_by`).
        policy:
          "Only these edge types may be used in an FAQ: `attributed_to` (an entry → the Principal who stewards it), `supports` (a result Log → the entry that resolved it — usage as evidence), `relates_to` (a see-also link between related questions), `has_parent` (place a narrower question under a broader topic question), `replaces` (a canonical entry supersedes a merged duplicate), and `derived_from` (an entry → the result Log(s) whose gap it was written to fill). An entry cites its source inline in its `locator`, not via an edge.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "attributed_to",
            "supports",
            "relates_to",
            "has_parent",
            "replaces",
            "derived_from",
          ],
        },
      },

      // ── Entry completeness (deterministic, committed stages only, block) ──
      {
        // Completeness floor — fires on the committed stages only
        // (FAQ_COMMITTED_LIFECYCLES): a `drafting` stub may be a bare question,
        // but a committed entry must carry its reply in `answer`. A question
        // with no answer is not yet an entry. (`answer` lives in the node's
        // `extra` bag, which the evaluator reads as a field — mirrors the
        // glossary `definition` gate.)
        policy:
          "Every committed (`queued` or `active`) FAQ entry carries an `answer` — a question with no reply is not yet an entry. A `drafting` stub may capture the question first and fill in the answer later.",
        predicate: {
          kind: "requires_field",
          fields: ["answer"],
          when_node_type: ["reference"],
        },
        fires_when_node_lifecycle: FAQ_COMMITTED_LIFECYCLES,
      },
      {
        // Ownership floor. A named owner is the single most effective defense
        // against a stale FAQ, so — unlike the glossary, which leaves
        // stewardship to guidance — the FAQ makes it a hard gate on committed
        // entries: a published answer names the Principal accountable for
        // keeping it current, via an `attributed_to` edge. A `drafting` sketch
        // may defer naming the steward. (Mirrors the decision-record decider
        // gate.)
        policy:
          "Every committed (`queued` or `active`) FAQ entry names the Principal who stewards it — an `attributed_to` edge from the entry to that Principal — so there is a clear owner accountable for keeping the answer fresh. A `drafting` entry may defer naming the steward.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["reference"],
        },
        fires_when_node_lifecycle: FAQ_COMMITTED_LIFECYCLES,
      },

      // ── Entry quality (probabilistic, LLM-judged, warn, committed only) ──
      // Warnings, not blocks: an LLM verdict is non-deterministic, so a block
      // both traps legitimate entries and can flip on retry. These surface the
      // gaps that make an FAQ useless without standing between the author and a
      // save. They fire only on the committed stages, like the deterministic
      // completeness gates — a `drafting` sketch is a work in progress and isn't
      // nagged about question phrasing or answer shape.
      {
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the FAQ entry's `prose` — the question. PASS when it poses ONE genuine question phrased the way a real user would ask it (e.g. `How do I reset my password?`, `Why was my card declined?`). FAIL when it bundles several questions into one entry, is phrased from the organization's point of view or in internal jargon rather than the user's words, or is a statement or topic label rather than a question.",
          when_node_type: ["reference"],
        },
        fires_when_node_lifecycle: FAQ_COMMITTED_LIFECYCLES,
      },
      {
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the FAQ entry's `answer` together with its `prose` (the question). PASS when the answer leads with the direct response to the question and is concise and self-contained enough to resolve it on its own (a couple of sentences or a short list), leaving deeper or authoritative detail to the linked source. FAIL when the answer buries or never states the actual answer, is a wall of text, is marketing copy rather than a plain reply, or merely re-points to a source without answering.",
          when_node_type: ["reference"],
        },
        fires_when_node_lifecycle: FAQ_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "Capture one question per entry, phrased the way people actually ask it. Mine the real wording from support tickets, chats, and search queries rather than inventing an idealized question, and split a compound question into separate entries so each has one clear answer.",
      },
      {
        policy:
          "Lead with the answer and keep it concise and scannable — enough to resolve the question on its own. Keep the authoritative detail in ONE place: cite the source of truth in the entry's `locator` and digest it in the `answer`, rather than copying it, so the answer can't drift out of sync with the source it summarizes.",
      },
      {
        policy:
          "Record the paraphrases people use to ask the same question as `alternatives` on the canonical entry (each `{ name, note }`), so a reader — or an agent matching on wording — who asks it a different way still lands on the one real answer instead of spawning a near-duplicate.",
      },
      {
        policy:
          "Keep one canonical entry per question. When two entries answer the same question, merge them: keep the better one, fold the other's wording in as `alternatives`, retire the duplicate (lifecycle `retired`), and link the survivor to it with a `replaces` edge (the `supersede` changeset op creates both at once) so a reader who finds the old one is redirected to the current answer.",
      },
      {
        policy:
          "Name a steward for every entry with an `attributed_to` edge to a Principal — a named owner is what keeps an answer from going stale. Record when the answer was last reviewed (a `last_reviewed_at` on the entry) and re-review on a cadence; ship the FAQ update in the same change as the work that changes the answer. A stale answer is worse than none — it sends people, and agents, confidently wrong.",
      },
      {
        policy:
          "Walk an entry through the lifecycle as it matures, which IS the KCS article state: `drafting` while the question is captured but the answer is unwritten or unvalidated (work in progress), `queued` once it is ready for review, `active` when it is the validated, in-force answer, and `retired` when it is archived or superseded. Completeness and quality gates apply once an entry is committed (`queued`/`active`); a `drafting` stub may be a bare question.",
      },
      {
        policy:
          "Log each result as a Log node: the question as it was actually asked in its `prose`, when in `happened_at`, and whether the FAQ resolved it in `outcome` (`succeeded` or `failed`). Link a resolved result to the entry that answered it with a `supports` edge — every use is a review (KCS 'reuse is review'), so the Logs that `supports` an entry are its reuse count and its evidence of health.",
      },
      {
        policy:
          "When a question is asked and no entry answers it, log that miss as a Log with `outcome: failed` and no `supports` edge — that orphan, and its raw question, is the demand signal for the next entry to write. When you write the entry that fills the gap, link it `derived_from` the Log(s) that revealed it. Don't write entries 'just in case'; let real questions pull them into being.",
      },
      {
        policy:
          "Don't store view counts or helpfulness tallies on the entry. The Logs are the atomic record of every result, so reuse, helpfulness (the share of `succeeded` outcomes), hot questions, and gap rate are all read off the usage stream — keep the entry the single source of the answer.",
      },
      {
        policy:
          "Cross-link related questions with `relates_to`, and group a narrower question under a broader topic question with `has_parent`, so the FAQ reads as a connected map rather than a flat list and a reader who lands on one entry can find its neighbors.",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write with `POST /<handle>/api/changesets.json`. Create each entry as a Reference with its `answer`, its question `alternatives`, a `locator` to the source of truth, and an `attributed_to` steward edge in one changeset; log each result as a Log with its `outcome` and, when an entry resolved it, a `supports` edge to that entry.",
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
    // GitHub bugs. A repository's bug issues (labeled bug, or of the Bug issue
    // type) are synced as Evals keyed on the issue URL, and a closed issue
    // retires its bug. Like every integration it fills a standalone Doco of its
    // own, never the Bug tracker people file bugs in, so it imposes no
    // authoring constraints; the GitHub integration, set up right after
    // creation, does the syncing.
    name: "github-bugs",
    label: "GitHub bugs",
    icon: "🐞",
    description:
      "Track a GitHub repository's bugs — issues labeled bug, or of the Bug issue type, sync automatically, and closed issues retire.",
    policies: [],
    perspectives: [{ slug: "list", isDefault: true }],
  },
  {
    // GitHub codebase. The Doco holds a copy of every file on the default
    // branch of the repositories it brings from, kept in sync on every push,
    // in the code_files table (not nodes: a file deleted in the repository
    // must really disappear). The GitHub setup fills it; knowledge distilled
    // from the code lives in the graph as usual.
    name: "codebase",
    label: "GitHub codebase",
    icon: "🗂️",
    description:
      "A copy of your GitHub repositories' code, kept in sync on every push, so it can be browsed and searched alongside your Doco knowledge.",
    policies: [],
    perspectives: [{ slug: "code", isDefault: true }],
  },
  {
    // Slack public-channel mirror. The Doco holds a read-only copy of a Slack
    // workspace's public channels, kept in sync, in the group_chat_* mirror
    // tables (not nodes: mirrored messages must be deletable). The Slack page,
    // opened right after creation, turns the mirror on. Knowledge distilled
    // from the conversations lives in the graph as usual.
    name: "slack",
    label: "Slack workspace",
    icon: "💬",
    description:
      "A read-only copy of a Slack workspace's public channels, kept in sync, so its conversations can be searched alongside your Doco knowledge.",
    policies: [],
    perspectives: [{ slug: "slack", isDefault: true }],
  },
  {
    // Notion mirror. The Doco holds a read-only copy of the Notion pages and
    // databases a workspace shares with the Doco integration, kept in sync, in
    // the notion_* mirror tables (not nodes: mirrored pages must be deletable).
    // The Notion page, opened right after creation, turns the mirror on.
    // Knowledge distilled from the pages lives in the graph as usual.
    name: "notion",
    label: "Notion workspace",
    icon: "📓",
    description:
      "A read-only copy of the Notion pages and databases you share, kept in sync, so they can be searched alongside your Doco knowledge.",
    policies: [],
    perspectives: [{ slug: "notion", isDefault: true }],
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
  {
    // AI test-eval log — document and track evaluations of AI systems. It
    // distills the durable two-layer shape every modern eval stack converges on
    // (OpenAI Evals, Anthropic's agent-eval and success-criteria guidance,
    // Inspect, Braintrust, Langfuse, Evidently) onto Doco's existing primitives,
    // adding NO new node type:
    //
    //   Layer 1 — the eval DEFINITION (the stable spine): WHAT behaviour is
    //   measured, on WHAT data, HOW the output is graded, and WHAT counts as
    //   success. This is the existing `eval` node — `prose` is what's checked +
    //   why, `criterion` is the grading method ({kind: exact | shape | llm-judge,
    //   spec}), with `how_to_run` / `expected` for reproduction. An eval changes
    //   rarely; when its methodology changes it is superseded, not edited.
    //
    //   Layer 2 — the run RESULT (append-only): ONE record per execution carrying
    //   the score(s), the pass/fail verdict, and the versions it ran against
    //   (model + prompt/agent, dataset, commit). This is the existing `log` node
    //   (`happened_at`, `inputs`, `outputs`, `outcome`), linked to the Eval it is
    //   a run of by a `supports` edge — the spine that makes a number comparable.
    //
    // Supporting cast (the expansion points that fit specific scenarios —
    // classification, RAG, agent/trajectory, safety/red-team — without bloating
    // the core): References hold the versioned dataset / golden set, the system
    // under test (a model + prompt version), the harness/code, and external
    // benchmarks or reports; Rules capture the SMART success criteria and release
    // gates (a threshold like "F1 ≥ 0.85" or "0 critical safety failures") linked
    // by `constrained_by`; Principals are the owners — human OR agent — who keep
    // an eval healthy. Suites group related evals under a parent Eval with
    // `has_parent`; a superseded eval is `replaces`-linked to the one it retires.
    //
    // What sets this template apart from `process` (which pushes recorded runs to
    // a sibling Doco): here the RESULTS are the point, so Logs live in the Doco
    // alongside the evals that produced them, building the longitudinal record
    // that catches regressions.
    //
    // Lifecycle: nodes default to `drafting`; completeness + quality gates fire on
    // the committed stages only (EVALS_COMMITTED_LIFECYCLES).
    name: "evals",
    label: "AI evals",
    icon: "🧪",
    description:
      "Document and track test evals for AI systems — each eval's task, dataset, grading method, and success criteria, plus an append-only log of every run's scores and pass/fail verdict, pinned to the model and prompt versions it tested. Grounded in current LLM-eval practice (dataset + grader + metrics; capability vs regression; pass@k).",
    defaultNodeLifecycle: "drafting",
    // An eval log is fundamentally a filterable list of evals and their runs, so
    // open the overview on the built-in List perspective. (Graph stays behind it.)
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Soft semantic gate — a `warn`, not a block. The author opted into the
        // eval log; this only surfaces "this isn't an eval, a run, or a
        // dataset/system" so they can reconsider. Owners (Principal) and
        // criteria/gates (Rule) are supporting cast, exempt by omission from
        // when_node_type.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in an AI-eval log when it is one of: an Eval (a test that measures some behaviour of an AI system — its task, the data it runs on, how the output is graded, and what counts as success); a Log (one recorded run of an eval, carrying its score and pass/fail verdict and the versions it ran against); or a Reference (the dataset / golden set being tested, the system under test such as a model + prompt version, the eval harness/code, or an external benchmark or report). PASS when the candidate is one of these. FAIL when it is a free-form note, a product or process artifact, or anything with no role in defining or recording an evaluation.",
          when_node_type: ["eval", "log", "reference"],
        },
      },
      {
        // Deterministic node-type allowlist. Flow/work nodes (Action, State) and
        // free-form Ideas, plus ship/rollback Decisions (which belong in a
        // decision-record Doco), are out; an eval log is evals + runs + the
        // data/systems they concern + their owners and gates.
        policy:
          "Only Eval, Log, Reference, Rule, and Principal belong in an AI-eval log. An Eval is the test definition (what is measured, on what data, how it is graded, the target); a Log is one recorded run of an eval (its score and verdict, and the versions it ran against); a Reference is the versioned dataset / golden set, the system under test (model + prompt version), the harness/code, or an external benchmark or report; a Rule captures a success criterion or release gate; a Principal is the owner — person or agent — accountable for the eval. Process steps, free-form notes, and ship decisions belong in their own Docos.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["eval", "log", "reference", "rule", "principal"],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist). An
        // eval log wires runs to their evals, evals to their data/criteria/owners,
        // and evals into suites and supersession chains. Process sequence flow
        // (`flows_to`) has no meaning here, so it is barred.
        policy:
          "Only these relationship edge types may be used in an AI-eval log: `supports` (a Log → the Eval it is a run of; a dataset/report Reference → the Eval it informs; an Eval → a claim it validates), `derived_from` (a Log → the system-under-test or dataset version it ran against; an Eval → a benchmark it adapts), `attributed_to` (an Eval or suite → the Principal who owns it), `constrained_by` (an Eval → a Rule stating its success criterion or release gate), `has_parent` (an Eval → the suite it belongs to), `replaces` (a new Eval version → the one it supersedes), and `relates_to` (a see-also link between related evals).",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "supports",
            "derived_from",
            "attributed_to",
            "constrained_by",
            "has_parent",
            "replaces",
            "relates_to",
          ],
        },
      },

      // ── Eval (definition) completeness & quality ────────────────
      {
        // Completeness floor — a committed eval declares HOW it decides pass/fail.
        // `criterion` is the grading method ({kind: exact | shape | llm-judge,
        // spec}); an eval with no grader can't be run, so it isn't yet an eval.
        // (`criterion` lives in the node's `extra` bag, which the evaluator reads
        // as a field; an empty object reads as missing.) A `drafting` sketch may
        // capture the intent first and choose the grader later.
        policy:
          "Every committed (`queued` or `active`) Eval declares its grading method in `criterion` — how a run's output is turned into a pass/fail or score: an exact/programmatic check, a shape/structural check, or an LLM-as-judge rubric. An eval with no grader can't be run; a `drafting` sketch may add it later.",
        predicate: {
          kind: "requires_field",
          fields: ["criterion"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: EVALS_COMMITTED_LIFECYCLES,
      },
      {
        // Eval-definition quality — LLM-judged, so a `warn`, not a block (a retry
        // could differ; warn nudges without trapping). Encodes the SMART
        // success-criteria rule: specific, measurable target tied to a dataset
        // and a grader.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Eval's `prose` and `criterion`. PASS when the eval is well-formed: it states WHAT behaviour is measured, on WHAT input or dataset, HOW the output is graded, and WHAT counts as success — a specific, measurable target (e.g. `exact-match accuracy ≥ 0.9 on the 200-case golden set`, `0 responses leak PII over 10k red-team prompts`, `LLM-judge rates tone ≥ 4/5 on 100 inquiries`). FAIL with a reason when it is vague about what success means (`works well`, `good quality`), names no way to grade the output, or bundles several unrelated checks into one eval.",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: EVALS_COMMITTED_LIFECYCLES,
      },

      // ── Run (result) completeness & quality ─────────────────────
      {
        // The SPINE: every committed run links to the eval it is a run of, via a
        // `supports` edge to that Eval. A result with no eval is an orphan number
        // — there is nothing to compare it against or attribute it to. A hard
        // block once committed; a `drafting` jot may defer the link.
        policy:
          "Every committed (`queued` or `active`) Log is one run of an eval: it links to that Eval with a `supports` edge. A run with no eval it belongs to is an orphaned number — there is nothing to compare it against, trend it over time, or attribute it to. A `drafting` run may defer the link.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          target_node_type: "eval",
          when_node_type: ["log"],
        },
        fires_when_node_lifecycle: EVALS_COMMITTED_LIFECYCLES,
      },
      {
        // Run quality — LLM-judged `warn`. A run is only useful later if it
        // records BOTH its result AND the versions it ran against, because an eval
        // measures the harness AND the model together; without the pins a later
        // reader can't tell whether a change moved the number.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Log's `prose`, `outputs`, `inputs`, and `happened_at`. PASS when the run records BOTH (a) its result — the score(s) and/or the pass/fail verdict for this execution — AND (b) the versions it ran against, enough to reproduce and compare it: the system under test (model + prompt/agent version, or commit) and, where relevant, the dataset version. FAIL with a reason when it records a bare verdict with no score, or no pinned versions, so a later reader can't tell what was tested or whether a change moved the number.",
          when_node_type: ["log"],
        },
        fires_when_node_lifecycle: EVALS_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "Keep the two layers distinct: the Eval is the durable DEFINITION (what is measured, on what data, how it is graded, the target) and changes rarely; each run is a separate, append-only Log RESULT linked to it by `supports`. Never overwrite a past run to record a new one — add a new Log — so the trend over time stays visible and regressions are catchable.",
      },
      {
        policy:
          "Choose the grading method deliberately and record it in the Eval's `criterion`: prefer a code-based / programmatic check (exact match, string/shape assertion, tool-call or final-state verification) when the answer is checkable — it is fast, cheap, and deterministic; use an LLM-as-judge with a clear, empirical rubric for open-ended or subjective output, and calibrate it against human labels before trusting it at scale; reserve human grading for the gold-standard spot checks that keep the automated graders honest. Many evals combine more than one.",
      },
      {
        policy:
          "Make success criteria SMART — specific, measurable, achievable, relevant. Capture the threshold or release gate as a Rule linked to the Eval with `constrained_by` (e.g. `F1 ≥ 0.85 on the held-out set`, `< 0.1% of 10k trials flagged toxic`, `p95 latency < 200ms`), so pass/fail is judged against an explicit bar rather than a vibe. Most real evals are multidimensional — quality plus safety plus latency plus cost — so attach more than one Rule when they apply.",
      },
      {
        policy:
          "Keep the test cases as a versioned dataset: model the golden set / eval data as a Reference whose `locator` points at where it lives, and cite it from the Eval with `supports` (or `derived_from`). Version it with immutable snapshots, keep it small but ruthlessly curated, and grow it by turning real production failures and user-reported bugs into new cases.",
      },
      {
        policy:
          "Pin what was evaluated on every run: an eval measures the harness AND the model together, so record the system under test — model + version, prompt/agent version, config, and code commit — on the Log (in its `inputs`, and/or as a `derived_from` edge to a Reference for that version). Two runs are only comparable when you can see exactly what changed between them.",
      },
      {
        policy:
          "Record the metric and the aggregate score, not just a verdict: accuracy, F1, precision/recall, an LLM-judge score, or operational numbers like latency, cost, and tokens. For non-deterministic systems, run multiple trials and report the right aggregate — `pass@k` (succeeds at least once in k tries) for capability, `pass^k` (succeeds on every one of k tries) for reliability — since the two diverge sharply as k grows.",
      },
      {
        policy:
          "Distinguish capability evals from regression evals. A capability eval targets behaviour the system struggles with and starts at a low pass rate; once it passes reliably, graduate it to a regression eval kept near 100% to guard against backsliding. Say which an eval is in its `prose`, and watch for saturation — when a capability eval nears 100% it has stopped discriminating and needs harder cases.",
      },
      {
        policy:
          "Give every eval an owner — a person OR an agent — by attributing it (or its suite) to a Principal with `attributed_to`, and set that Principal's `kind` to `human` or `agent`. Eval suites rot without maintenance: someone has to read the transcripts, confirm the graders still grade correctly, retire saturated cases, and add new ones from fresh failures.",
      },
      {
        policy:
          "Group related evals into a suite: make the suite a parent Eval and link each member to it with `has_parent`, so a capability or product area reads as one set with a shared pass rate. When an eval's methodology changes, do NOT edit it in place — create the new version and link it to the old one with `replaces` (retiring the old), so past results stay interpretable against the definition that produced them.",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write with `POST /<handle>/api/changesets.json`. Create each run as a Log together with its `supports` edge to the Eval (and a `derived_from` edge to the system-under-test Reference) in the same changeset, recording the score, the verdict, and the pinned model / prompt / dataset versions — rather than leaving disconnected nodes.",
      },
    ],
  },
  {
    // Bug tracker — document and track software defects from report to fix.
    //
    // The deep abstraction: a bug IS a failing Eval. Every bug, in every
    // domain, reduces to the same irreducible core — a reproducible
    // *discrepancy between expected and actual behavior*, driven to a
    // resolution (the convergence of Spolsky's "exactly three things", Tatham's
    // saw-vs-expected, IEEE 1044's defect/fault/failure model, and the Bugzilla
    // status × resolution two-axis workflow). That core already IS the Eval
    // node: `expected` (the correct behavior), `actual` (the observed wrong
    // behavior), `how_to_run` (the steps to reproduce), `input` (the minimal
    // reproducing input), `criterion` (how a fix is confirmed), and the
    // `last_status` (`fail` while the bug reproduces, `pass` once a fix is
    // verified). So the template needs NO new node type — it cultivates the
    // existing Eval, exactly as the decision-record templates cultivate
    // Decision and the glossary cultivates Reference.
    //
    // The payoff of that choice: a bug and its regression test become ONE node
    // seen at two moments — red when reported, green when fixed. "A bug fix
    // isn't done without a regression test that was red before and green after"
    // (test-first / red-green-refactor) falls straight out of the model rather
    // than being bolted on.
    //
    // Two orthogonal axes, mirroring every mature tracker:
    //   - STATUS rides on the node lifecycle: `drafting` (reported / unconfirmed)
    //     → `queued` (triaged & accepted) → `active` (confirmed, being worked)
    //     → `retired` (closed). Completeness gates fire on the committed stages
    //     only (BUG_COMMITTED_LIFECYCLES), so a raw report is never blocked.
    //   - DISPOSITION — how a bug *ended* — rides in a `resolution` field
    //     (`fixed` / `duplicate` / `cannot_reproduce` / `by_design` /
    //     `wont_fix`), set when the bug is retired.
    //
    // The supporting cast (the node-type allowlist): the bug itself is an Eval;
    // a Principal is the single accountable owner; References carry the
    // evidence (stack traces, screenshots, logs) and the fix (the PR / commit);
    // Logs are individual occurrences in the wild (crash reports, error-tracker
    // events); Rules state the behavior contract / invariant the bug violates,
    // which related defects can share.
    //
    // Expandable to specific scenarios without schema change: the universal
    // core is mandatory; domain specifics ride in `extra` fields and linked
    // Rules / References. A security vulnerability adds `cve`, `cvss`, `cwe`,
    // and affected versions and `constrained_by` the weakness/policy it
    // violates; a performance regression adds a metric and its baseline; a
    // data-pipeline bug links the dataset and names expected vs actual counts.
    // Because the membership / quality gates are probabilistic (not rigid
    // schemas), a team can add domain fields without fighting the template —
    // the small invariant spine with snap-on extensions Spolsky argues for
    // ("avoid the temptation to add new fields").
    name: "bugs",
    label: "Bug tracker",
    icon: "🐛",
    description:
      "Track software bugs as failing checks — the expected vs actual behavior, steps to reproduce, severity and priority, root cause, the fix, and a regression test that turns from red to green. Grounded in defect-management practice (IEEE 1044, ODC, ISTQB) and blameless-postmortem culture.",
    // A bug is reported (a sketch) before it is triaged, so new nodes default to
    // `drafting` and the completeness/quality gates spare a raw report.
    defaultNodeLifecycle: "drafting",
    // A bug tracker is fundamentally a filterable list of records, so open the
    // overview on the built-in List perspective. (Graph stays attached behind
    // it.) No bespoke perspective — the decision-record templates do the same.
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership (soft semantic gate) ──────────────────────────────
      {
        // Warn, not block: the author opted into the bug tracker, so this only
        // surfaces "this isn't really a defect" for reconsideration. It steers
        // feature requests and how-to questions toward a product-decisions or
        // process Doco. Scoped to the Eval (the bug record); the supporting
        // cast — Principals (owners), References (evidence / fix), Logs
        // (occurrences), Rules (violated contracts) — is exempt by omission.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in a bug tracker when it documents a real software defect — a discrepancy between how the system is expected to behave and how it actually behaves. PASS when the candidate describes something the system does wrong (a crash, a wrong result, a broken interaction, a violated guarantee) against a clear expectation. FAIL when it is a feature request or enhancement (desired NEW behavior, not a malfunction), a how-to question, a support request, or a task with no expected-vs-actual discrepancy — those belong in a product, process, or decision Doco.",
          when_node_type: ["eval"],
        },
      },
      {
        // Deterministic node-type allowlist. A bug tracker is the defects
        // themselves plus the cast that gives each one meaning: the Eval is the
        // bug (and its regression test); a Principal is the accountable owner;
        // References carry evidence and the fix; Logs are occurrences in the
        // wild; Rules are the behavior contracts a bug violates. Flow nodes
        // (Action / State), free-form Ideas, and Decisions belong in their own
        // Docos and are linked, not duplicated, here.
        policy:
          "Only Eval, Principal, Reference, Log, and Rule belong in a bug tracker. Each bug is an Eval — its `expected` and `actual` are the discrepancy, its `how_to_run` the steps to reproduce, and its `last_status` flips from `fail` to `pass` when a fix is verified. Principals are the accountable owners; References carry evidence (stack traces, screenshots, logs) and the fix (the PR or commit); Logs record individual occurrences in the wild; Rules state the behavior contract a bug violates. Process steps, decisions, and free-form notes belong in their own Docos.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["eval", "principal", "reference", "log", "rule"],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist). A
        // bug tracker wires owners, evidence, violated contracts, supersession,
        // provenance, and see-also links — never process sequence flow or pool
        // membership.
        policy:
          "Only these relationship edge types may be used in a bug tracker: `attributed_to` (a bug → its accountable owner Principal), `supports` (evidence, occurrences, and the fix → the bug they inform or resolve), `constrained_by` (a bug → the Rule / spec / invariant it violates), `replaces` (a canonical bug supersedes a duplicate, or a regression supersedes a prior fixed bug), `derived_from` (provenance — the change or commit that introduced the bug), and `relates_to` (a see-also link between related bugs). Process flow (`flows_to`) and pool membership (`has_parent`) belong in a process Doco.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "attributed_to",
            "supports",
            "constrained_by",
            "replaces",
            "derived_from",
            "relates_to",
          ],
        },
      },

      // ── Completeness: the discrepancy + reproduction (block, committed) ──
      {
        // The irreducible core — Spolsky's "exactly three things" (expected,
        // actual, steps to reproduce) and the deepest common denominator across
        // the whole literature. A committed (triaged) bug must carry all three;
        // remove any one and the report is not actionable. A `drafting` report
        // may be a bare description while the reporter is still capturing it.
        // (`how_to_run` is the native Eval field that holds the reproduction
        // steps; `expected` / `actual` are the native Eval fields.)
        policy:
          "Every committed (`queued` or `active`) bug documents the discrepancy and how to see it: `expected` (the correct behavior), `actual` (the observed wrong behavior), and `how_to_run` (the steps to reproduce). These three are the irreducible core of a bug — a `drafting` report may capture just a description and fill them in during triage.",
        predicate: {
          kind: "requires_field",
          fields: ["expected", "actual", "how_to_run"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: BUG_COMMITTED_LIFECYCLES,
      },
      {
        // Triage rating — surfaced as a WARN, not a block. Severity and priority
        // are near-universal but, per the literature, a notch below the core
        // discrepancy: strongly recommended, occasionally optional (Spolsky's
        // warning against over-fielding made into enforcement level). A
        // deterministic warn nudges the triager to rate the bug without
        // trapping the write.
        on_violation: "warn",
        policy:
          "A triaged bug is rated on two orthogonal axes: `severity` (impact if it happens) and `priority` (urgency to fix). Recording both is strongly recommended on a committed bug — surfaced as a warning, not enforced, so a bug can move while its rating is still being settled.",
        predicate: {
          kind: "requires_field",
          fields: ["severity", "priority"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: BUG_COMMITTED_LIFECYCLES,
      },

      // ── Accountability: one owner (block, committed) ─────────────────
      {
        // A bug is a "hot potato" — always assigned to exactly one person, who
        // either resolves it or hands it on (Spolsky). A committed bug names
        // that owner via an `attributed_to` edge to a Principal, mirroring the
        // decision-record and process attribution gates. A `drafting` report
        // may defer naming the owner until triage.
        policy:
          "Every committed (`queued` or `active`) bug is attributed to exactly one accountable owner — an `attributed_to` edge from the bug to that Principal. A bug is a hot potato: it is always owned by one person who drives it to resolution or explicitly hands it on. A `drafting` report may defer naming the owner until triage.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: BUG_COMMITTED_LIFECYCLES,
      },

      // ── Report quality (probabilistic, warn, committed) ──────────────
      {
        // LLM-judged, so a warn (an identical retry could differ). Encodes
        // Tatham's "show, don't tell" and the minimal-reproducible-example
        // discipline: a committed bug should be concrete enough that another
        // engineer can see the program failing in front of them.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the bug's `expected`, `actual`, and `how_to_run`. PASS when they are concrete and specific enough that another engineer could reproduce the defect and recognize the wrong behavior — exact observations (the verbatim message, the actual number, the precise wrong output), not vague claims like `it doesn't work` or `the page is broken`. The steps should be a minimal, deterministic path to the failure; if it only reproduces intermittently, the report should say so. FAIL with a reason when expected or actual is vague or generic, when the steps are too thin to follow, or when the report substitutes a guess at the cause for the observable symptoms.",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: BUG_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only suggestions) ────────────────────────────
      {
        policy:
          "Model each bug as an Eval — a check that currently fails and ought to pass. Put the correct behavior in `expected`, the observed wrong behavior in `actual`, the numbered steps to reproduce in `how_to_run`, the smallest triggering input in `input`, and how a fix will be confirmed in `criterion`. While the bug is open its check fails (`last_status: fail`); a verified fix flips it to `pass` (`expected_status: pass`). The bug and its regression test are one node seen at two moments — red when reported, green when fixed.",
      },
      {
        policy:
          "The discrepancy IS the bug — show, don't tell. State `expected` and `actual` as concrete, verbatim observations (the exact error message, the number the computer reported, the precise wrong output), never `it doesn't work`. A good report lets a stranger see the program failing in front of them. Keep any guess at the cause separate from the observed facts — never substitute a diagnosis for the symptoms.",
      },
      {
        policy:
          "Make it reproducible, and narrow it down. Put deterministic, numbered steps in `how_to_run` and reduce them to the smallest input that still triggers the defect (a minimal reproducible example, in `input`). If it only reproduces sometimes, say so and give the rate — an intermittent bug is investigated differently. Record the environment (build / version, OS, device) and attach stack traces, screenshots, and logs as References that `supports` the bug; keep the failing run's detail in `last_reason`.",
      },
      {
        policy:
          "Severity and priority are different, orthogonal axes — record both. Severity is the impact if it happens (data loss > crash > major > minor > cosmetic); priority is the urgency to fix (P0 now → P3 someday). They diverge: a typo on the landing page is low severity but high priority; a crash in a tool no one uses is high severity but low priority. Don't let one stand in for the other.",
      },
      {
        policy:
          "Track two axes, not one: the bug's STATUS on its lifecycle, and how it ENDED in a `resolution` field. Status: `drafting` = reported / unconfirmed (triage pending), `queued` = triaged & accepted (reproduced, rated, owned), `active` = confirmed and being worked, `retired` = closed. Resolution (set when retiring): `fixed` (verified — the regression check passes), `duplicate` (retire it; the canonical bug `replaces` it), `cannot_reproduce`, `by_design` (working as intended), or `wont_fix` (acknowledged, not worth fixing). Completeness rules apply once a bug is committed; a `drafting` report may be incomplete.",
      },
      {
        policy:
          "Triage before you commit a bug. Reproduce it, confirm it is a real defect (not a feature request, not by-design), set `severity` and `priority`, and give it exactly one accountable owner with an `attributed_to` edge. Deduplicate first: if the defect is already tracked, retire this record and point the canonical bug at it with a `replaces` edge, so discussion and the `me too` signal consolidate onto one bug.",
      },
      {
        policy:
          "Keep one defect per bug. Each Eval is exactly one bug, so it can be reproduced, fixed, verified, and closed on its own. Split a report that bundles several problems into separate bugs and connect them with `relates_to`.",
      },
      {
        policy:
          "Find the root cause; fix the cause, not the symptom. Investigate to the underlying defect (ask `why` down to the real cause, or spread the candidates across people / process / code / environment) and record it in the bug's prose — the symptom is where you start, not where you stop. When a specific change introduced a regression, link that commit or PR as a Reference with a `derived_from` edge. State the behavior contract the bug violates as a Rule and link it with `constrained_by`, so related defects can share one invariant.",
      },
      {
        policy:
          "Link the fix, then prove it with a regression test. Record the fix as a Reference (the PR, commit, or changeset) that `supports` the bug. A fix is not done until a test that was red before it is green after — and the bug Eval IS that test: set its `criterion` and flip `last_status` to `pass` once the corrected behavior holds. Close the loop the way you opened it — whoever reported the bug confirms the fix and retires it, not the person who wrote the fix.",
      },
      {
        policy:
          "Record recurring occurrences as Logs, not duplicate bugs. When the same defect is hit repeatedly in the wild (crash reports, error-tracker events), capture instances as Logs that `supports` the bug, so frequency and recency stay visible on one record. If a closed bug recurs, open a NEW bug and link the prior one with `replaces` — a regression is a new defect, and preserving its history is the point of the log.",
      },
      {
        policy:
          "Escalate a production-impacting bug to a blameless postmortem. For a defect that caused a user- or business-visible incident, write up the timeline, contributing factors, and action items without blame — fix the system, not the people — and link it, tracking each action item as its own bug. The incident (the impact event) and the bug (the defect behind it) are distinct: one incident can implicate several bugs.",
      },
      {
        policy:
          "The core is universal; your domain rides on top. Every bug captures the same spine — a reproducible discrepancy between `expected` and `actual`, rated by severity and priority, driven through triage → fix → verified-by-a-regression-check → closed. Domain specifics ride in extra fields and linked Rules / References without changing that spine: a security vulnerability adds `cve`, `cvss`, and `cwe` and affected versions, and links the weakness or security policy it violates as a Rule via `constrained_by`; a performance regression adds the metric and its baseline; a data-pipeline bug links the affected dataset and names expected vs actual record counts.",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write entries with `POST /<handle>/api/changesets.json` — create each bug as an Eval with its `expected`, `actual`, and `how_to_run` (and `severity` / `priority` once triaged), and add its `attributed_to` owner together with any `supports` / `constrained_by` edges in the same changeset rather than as disconnected nodes.",
      },
    ],
  },
  {
    // Product roadmap — document a team's outcome-oriented bets over time and,
    // crucially, CLOSE THE LOOP on whether each one worked. The shape distills
    // the durable consensus of modern product practice (Cagan / SVPG, Teresa
    // Torres' continuous discovery, Roman Pichler's GO roadmap, Melissa Perri,
    // and ProdPad's Now/Next/Later) onto Doco's primitives:
    //   - OUTCOMES OVER OUTPUTS. A roadmap item is an Intent — a desired outcome
    //     (a change in user behavior or a business result) with the metric that
    //     tells you it happened — not a feature to ship. The widely-cited claim
    //     is that ~95% of roadmaps are output, not outcome; the membership and
    //     outcome gates here steer authors the other way.
    //   - NOW / NEXT / LATER. Each item carries a `horizon` bucket — the
    //     lowest-commitment, most widely-applicable roadmap shape, where
    //     commitment and detail fall off the further out you look. Precise
    //     far-future dates are an EXTENSION, not the core: a dated roadmap reads
    //     as a promise it can't keep and assumes the first solution works.
    //   - ONE ACCOUNTABLE OWNER. Every committed item is `attributed_to` a
    //     Principal — the person, role, or team answerable for the outcome.
    //   - CLOSE THE LOOP (the differentiator the literature plans richly but
    //     rarely ships). Shipping is not success: a bet is done when it is
    //     MEASURED. Each item's result is an Eval that `supports` it, carrying
    //     the target (`expected`) and the actual measured result, its
    //     `last_status` running pending (measuring) → pass (validated) / fail
    //     (invalidated). The decision that follows — persevere, iterate, pivot,
    //     or kill — and the learning are recorded so the next bet compounds.
    //
    // Lifecycle maps onto the roadmap's own progression: `drafting` = a parked
    // idea / Later candidate still being shaped (it may lack an owner or a
    // horizon); `queued` = planned and committed (Next); `active` = in progress
    // (Now); `retired` = shipped and closed. Completeness gates fire on the
    // committed stages (`queued`/`active`) only (ROADMAP_COMMITTED_LIFECYCLES),
    // so a parking-lot idea can be sketched freely and is held to the full bar
    // only once it is committed to the roadmap.
    //
    // Out of scope, kept in sibling Docos and referenced from here: the
    // delivery PROCESS (Action/State flow → a `process` Doco) and the dated
    // shipped CHANGELOG (Logs). A roadmap documents intent and outcomes — not
    // the backlog of tasks nor the release plan.
    name: "product-roadmap",
    label: "Product roadmap",
    icon: "🗺️",
    description:
      "Document outcome-oriented product bets over Now / Next / Later horizons — each with an accountable owner, a measurable target, and a result that closes the loop on whether it worked. Grounded in outcome-over-output roadmap practice.",
    defaultNodeLifecycle: "drafting",
    // A roadmap is fundamentally a filterable list of bets, so open the overview
    // on the built-in List perspective. (Graph stays attached behind it.)
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership (soft semantic gate) ──────────────────────────────
      {
        // Warn, not block: the author opted into the roadmap by picking the
        // template, so this only surfaces "this looks like delivery/backlog
        // content, not a roadmap bet" for reconsideration. Principals (owners)
        // and Rules (criteria/guardrails) are supporting cast, not bets, so they
        // are exempt — omitted from `when_node_type`.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs on a product roadmap when it documents an outcome-oriented bet or its result: an Intent (a desired outcome — a user-behavior change or business result — the team is betting on), an Eval (the measurement that says whether an outcome was met), a Decision (a prioritization call about what to bet on and why), or a Reference (the discovery, research, or data informing a bet). PASS when the candidate is one of these. FAIL when it instead describes HOW work gets built or delivered — a process step or implementation task, a release / changelog event, a UI spec, or a one-off incident — which belongs in a process Doco or the backlog, not on the roadmap.",
          when_node_type: ["intent", "eval", "decision", "reference"],
        },
      },
      // ── Node-type allowlist (hard block) ─────────────────────────────
      {
        policy:
          "Only Intent, Eval, Principal, Reference, Decision, and Rule belong on a product roadmap. An Intent is a roadmap item — a desired outcome the team is betting on; an Eval is that bet's result — the measurement of whether the outcome was met; a Principal is the accountable owner; a Reference links the discovery, research, or data behind a bet; a Decision records a prioritization call; a Rule captures success criteria or guardrails. Delivery steps (Action), milestones (State), and shipped-event logs (Log) describe how and when work is built — they belong in a process Doco or a changelog, not on the roadmap.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["intent", "eval", "principal", "reference", "decision", "rule"],
        },
      },
      // ── Edge-type allowlist (hard block) ─────────────────────────────
      {
        policy:
          "Only these relationship edge types belong on a product roadmap: `has_parent` (group an initiative under the outcome, theme, or objective it serves), `attributed_to` (a roadmap item → its accountable owner Principal), `supports` (an Eval result, or a Reference's evidence, → the item it measures or informs), `constrained_by` (an item → a Rule that sets its success criteria or guardrails), `relates_to` (a dependency or see-also between items), `derived_from` (a bet's provenance from discovery or a prior item), and `replaces` (a re-scoped item supersedes the one it replaces). Process sequence flow (`flows_to`) describes delivery, not strategy, and has no place on a roadmap.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "has_parent",
            "attributed_to",
            "supports",
            "constrained_by",
            "relates_to",
            "derived_from",
            "replaces",
          ],
        },
      },
      // ── Owner accountability (deterministic, committed only) ──────────
      {
        // Every committed bet names who is answerable for its outcome, via an
        // `attributed_to` edge to a Principal — the roadmap analogue of the
        // decision-record decider gate. A `drafting` (Later / parked) idea may
        // defer naming an owner.
        policy:
          "Every committed (`queued` or `active`) roadmap item is attributed to the Principal accountable for its outcome — an `attributed_to` edge from the Intent to that owner. A `drafting` (parked / Later) idea may defer naming an owner.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ROADMAP_COMMITTED_LIFECYCLES,
      },
      // ── Horizon placement (deterministic, committed only) ─────────────
      {
        // The `horizon` field (Now / Next / Later) is what places an item ON the
        // roadmap; a committed item without one isn't really on it yet.
        // Engine-checked for presence via `requires_field`; the Now/Next/Later
        // vocabulary itself is guidance (the engine checks shape, the prose
        // carries meaning). A `drafting` parking-lot idea may defer its horizon.
        policy:
          "Every committed (`queued` or `active`) roadmap item carries a `horizon` — its Now / Next / Later bucket — so the roadmap stays ordered by time-confidence rather than by precise dates. A `drafting` idea in the parking lot may defer its horizon until it is committed.",
        predicate: {
          kind: "requires_field",
          fields: ["horizon"],
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ROADMAP_COMMITTED_LIFECYCLES,
      },
      // ── Result links its target (deterministic, committed only) ───────
      {
        // A result must measure something. A committed Eval links the item it
        // measures with an outgoing `supports` edge — the same gate the process
        // template puts on its Evals. Without it the result is a dangling metric
        // the roadmap can't attach to a bet.
        policy:
          "Every committed (`queued` or `active`) result links to the item it measures with a `supports` edge to that Intent. A result that measures nothing is a dangling metric; the `supports` edge is what lets the roadmap show whether a bet paid off.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: ROADMAP_COMMITTED_LIFECYCLES,
      },
      // ── Outcome over output (probabilistic, warn, committed) ──────────
      {
        // The spine of modern roadmapping, encoded as an LLM-judged warn (a
        // block would be non-deterministic and could trap a legitimate item).
        // Fires on the committed stages only — a drafting sketch isn't nagged.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the roadmap item's `prose`. PASS when it frames a desired OUTCOME — a change in user behavior or a business result, for a stated audience — together with how success will be measured (a metric and a target). A good item reads like `cut new-team setup time so 40% reach first value in week one`, not `build an onboarding checklist`. FAIL with a reason when it names only a feature or output to ship with no outcome behind it, states a vague theme with no measurable target, or reads as an implementation task. The point of a roadmap is the outcome, not the output.",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ROADMAP_COMMITTED_LIFECYCLES,
      },
      // ── Result closes the loop (probabilistic, warn, committed) ───────
      {
        // The differentiator: most roadmaps never check whether a shipped bet
        // moved its metric. This judges that a result actually closes the loop.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Eval result. PASS when it closes the loop on its bet: it states the target that was set (the `expected` metric value), the actual measured result, whether the target was met (its `last_status`: pending while still measuring, pass = validated, fail = invalidated), and the decision that follows — persevere, iterate, pivot, or kill — with the learning to carry forward. FAIL with a reason when it records a target with no result, a result with no target to judge it against, or a verdict with no decision or learning. A result that does not close the loop teaches the next bet nothing.",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: ROADMAP_COMMITTED_LIFECYCLES,
      },
      // ── Owner shape (probabilistic, warn) ────────────────────────────
      {
        // Nudge toward a single, clearly accountable owner. Warn, since the
        // Principal endpoint permits a quick name-only create.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Principal's `prose`. PASS when it names a single accountable owner for outcomes — a person, role, or team answerable for whether a bet pays off. FAIL when it is a vague label (`the team`, `product`) with no clear accountability, or an empty shell with only a bare name.",
          when_node_type: ["principal"],
        },
      },
      // ── Guidance (prose-only suggestions) ────────────────────────────
      {
        policy:
          "Lead with outcomes, not outputs. Frame each item as the change you want to see — a shift in user behavior or a business result — not the feature you will ship. `Build dark mode` is an output; `raise long-session retention by giving night readers a comfortable view` is the outcome behind it. The feature is just one bet on that outcome; name the outcome so a better bet can replace the feature without rewriting the roadmap.",
      },
      {
        policy:
          "Bucket every item into a Now / Next / Later `horizon`, and let commitment and detail fall off with distance: Now is in progress and fully specified, Next is coming up with less detail, Later is a direction — a problem worth solving with no committed solution yet. Resist putting precise far-future dates on the roadmap; they get read as promises and assume the estimate holds and the first solution works. Reserve real dates for high-integrity commitments made AFTER discovery (an extension: add a target date to a Now item, or coordinate the launch in a delivery Doco).",
      },
      {
        policy:
          "Give every committed item one accountable owner — an `attributed_to` edge to the Principal answerable for the outcome, not merely whoever builds it. Shared ownership is no ownership.",
      },
      {
        policy:
          "Group bets under the outcome, theme, or objective they serve with `has_parent`, so the roadmap reads as a few goals with bets beneath them rather than a flat feature list. To align with OKRs, model the Objective as the parent Intent and each bet's Key Result as its target Eval — map outcomes to Key Results, never features to Key Results.",
      },
      {
        policy:
          "Prioritize explicitly and show your work. Record a prioritization call as a Decision (what you are betting on over what, and why), and capture the criteria or scoring behind it — value vs. effort, or RICE (Reach × Impact × Confidence ÷ Effort), or whatever your team trusts — as a Rule linked with `constrained_by`. Keep the score together with its inputs so the ranking stays auditable; the framework itself is your team's choice, not the roadmap's.",
      },
      {
        policy:
          "Ground bets in evidence. Link the discovery that informs an item — user interviews, an experiment, analytics, a brief, or an opportunity from a discovery tree — as a Reference via `supports` (or `derived_from` when the bet grew directly out of that finding), so a reader can tell whether a bet rests on insight or on a hunch.",
      },
      {
        policy:
          "Wire dependencies between items with `relates_to`, so a bet that is blocked by or must coordinate with another shows the link rather than failing silently when its prerequisite slips.",
      },
      {
        policy:
          "Close the loop — this is the half most roadmaps skip. Shipping is not success; a bet is done when it is MEASURED. When an item ships, give it a result Eval linked by `supports` that carries the target you set (`expected`) and, over the measurement window, the actual result; move its `last_status` from pending (measuring) to pass (validated) or fail (invalidated); and record the decision that follows — persevere, iterate, pivot, or kill — with the learning, before you `retire` the item. A failed bet that taught you something is worth more than a shipped feature nobody measured.",
      },
      {
        policy:
          "Revisit the roadmap on a cadence — quarterly to re-prioritize bets and score outcomes, more often (every week or two) when uncertainty is high — rather than setting it once and treating it as a contract. Re-bucket horizons as you learn. When a bet's direction changes, supersede it instead of rewriting it: create the re-scoped item, link it to the old one with `replaces`, and `retire` the original, so the roadmap keeps a history of what you bet on and why it changed.",
      },
      {
        policy:
          "A roadmap is not a backlog and not a release plan. Keep stories, tasks, and bug lists in the backlog, the delivery flow in a `process` Doco, and the dated shipped history in a changelog of Logs. Reference those siblings from a roadmap item rather than absorbing them — the roadmap stays at the altitude of outcomes and bets, linking down to execution rather than becoming it.",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write with `POST /<handle>/api/changesets.json`. Create each roadmap item as an Intent with its `horizon`, its `attributed_to` owner, and (once it ships) its result Eval and the `supports` edge in the same changeset, rather than as disconnected nodes.",
      },
    ],
  },
  {
    // Test scenarios for websites and apps — and the log of what happened
    // every time they ran. The shape distills the durable test-documentation
    // best practices (ISTQB / IEEE 829 test case + test log, BDD's
    // Given/When/Then, and session-based exploratory testing) onto Doco's
    // primitives, around one core split:
    //
    //   - A SCENARIO is an Eval — the durable spec: what behavior should hold,
    //     the preconditions and steps to exercise it (`how_to_run`), and the
    //     single observable expected result (`expected` / `expected_status`).
    //     The Eval also caches the latest verdict (`last_status`, `last_run_at`,
    //     `last_reason`) so the card answers "is it green right now?".
    //   - A RUN is a Log — one execution at a point in time: the environment it
    //     ran against (browser, OS, device, build, URL), the outcome
    //     (`outcome` succeeded/failed, plus blocked/skipped in prose), and the
    //     evidence. Runs are append-only, so the history of passes and failures
    //     — and the environments they happened in — is never overwritten.
    //
    // Everything else hangs off that split: an Intent is the objective, charter,
    // or suite a scenario covers; a Reference is a requirement, environment,
    // evidence artifact (screenshot / recording / log), or a defect ticket; a
    // Principal is the tester, CI pipeline, or agent that owns or runs a test.
    // `supports` is the evidence/validation spine — an evidence Reference
    // supports a Log, a Log supports the Eval it ran, and the Eval supports the
    // objective or requirement it verifies — so traceability reads end to end.
    //
    // Lifecycle: scenarios default to `drafting` so a test can be sketched
    // before its steps and expected result are written; the completeness and
    // quality gates fire on the committed stages (`queued`, `active`) only
    // (TEST_SCENARIO_COMMITTED_LIFECYCLES). A run is a fact that already
    // happened, so it is recorded as `active`.
    name: "test-scenarios",
    label: "Test scenarios",
    icon: "🧪",
    description:
      "Document test scenarios for websites and apps and log every run — each scenario captures preconditions, steps, and the expected result; each run records the environment, outcome, and evidence. Grounded in ISTQB / IEEE 829 test documentation and session-based exploratory testing.",
    defaultNodeLifecycle: "drafting",
    // Open a new test Doco on the list reading — a test Doco is naturally a
    // list of scenarios and their runs. Graph + list defaults sit behind it.
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership (soft semantic gate) ──────────────────────────────
      {
        // Warn, not block: the author opted into the test template, so this only
        // surfaces "this looks like it belongs in another Doco kind" for
        // reconsideration. Principals (testers / systems) are exempt — they are
        // actors, not test content — by omitting them from `when_node_type`.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in a test Doco when it documents what to verify or what happened when it was verified: a test scenario (Eval — preconditions, steps, and an expected result), a recorded run or result (Log — what happened in a given environment), the objective / charter / suite a scenario covers (Intent), or external context — a requirement, environment, evidence artifact, or defect (Reference). PASS when the candidate is one of these. FAIL when it instead belongs in another Doco kind — a business-process step, a glossary term, a generic decision record, or a free-form note that is not a test, a run, an objective, or a referenced artifact.",
          when_node_type: ["eval", "log", "intent", "reference"],
        },
      },

      // ── Node-type allowlist (hard block) ─────────────────────────────
      {
        policy:
          "Only Eval (test scenarios), Log (recorded runs and their results), Intent (the objective, charter, or suite a scenario covers), Reference (a requirement, environment, evidence artifact, or defect), and Principal (the tester, automation system, or agent that owns or runs a test) belong in a test Doco. Process steps, glossary terms, and decision records live in their own Docos and are cited here via Reference.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["eval", "intent", "log", "principal", "reference"],
        },
      },

      // ── Edge-type allowlist (hard block) ─────────────────────────────
      {
        // The edge analogue of the node-type allowlist. `supports` is the
        // evidence/validation spine; process-flow (`flows_to`) and Rule-guard
        // (`constrained_by`) edges describe how work runs and don't belong here.
        policy:
          "Only these relationship edge types belong in a test Doco: `supports` (the evidence/validation spine — an Eval supports the objective or requirement it verifies, a Log supports the Eval it ran, and an evidence Reference supports a Log), `attributed_to` (the Principal who owns a scenario or ran a test), `has_parent` (nest an objective or suite under a broader test plan), `relates_to` (a see-also between scenarios, or a link from a failing run or scenario to a defect), `replaces` (a new scenario supersedes a retired one), and `derived_from` (provenance — a scenario derived from an imported spec or forked from another). Process-flow (`flows_to`) and Rule-guard (`constrained_by`) edges do not belong here.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "supports",
            "attributed_to",
            "has_parent",
            "relates_to",
            "replaces",
            "derived_from",
          ],
        },
      },

      // ── Scenario completeness floor (hard block, committed only) ──────
      {
        // A scenario you can't execute is an objective (an Intent), not a test.
        // `how_to_run` carries the preconditions + ordered steps; it is the
        // checkable floor that separates a runnable scenario from a wish. Fires
        // on the committed stages only (TEST_SCENARIO_COMMITTED_LIFECYCLES) so a
        // `drafting` sketch may capture the idea before the steps are written.
        policy:
          "Every committed (`queued` or `active`) test scenario says how to run it: its `how_to_run` carries the preconditions and the ordered steps a tester or agent follows. A scenario with no way to run it is an objective (an Intent), not a test. A `drafting` sketch may capture the idea before the steps are written.",
        predicate: {
          kind: "requires_field",
          fields: ["how_to_run"],
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: TEST_SCENARIO_COMMITTED_LIFECYCLES,
      },

      // ── Traceability (warn, committed only) ──────────────────────────
      {
        // One gate covering both halves of the split: a committed scenario
        // (Eval) `supports` the objective or requirement it verifies, and a
        // committed run (Log) `supports` the scenario it executed. Warn, not
        // block — an ad-hoc smoke check or a quick capture is allowed, but an
        // orphan run (which scenario did it test?) or an untraced scenario
        // (which requirement does it cover?) is surfaced for wiring up.
        on_violation: "warn",
        policy:
          "Every committed scenario and run links to what it covers with a `supports` edge: a scenario `supports` the objective (Intent) or requirement (Reference) it verifies, and a run (Log) `supports` the scenario (Eval) it executed. A run with no scenario is an orphan result; a committed scenario with no objective or requirement is an untraced test.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          when_node_type: ["eval", "log"],
        },
        fires_when_node_lifecycle: TEST_SCENARIO_COMMITTED_LIFECYCLES,
      },

      // ── Scenario quality (warn, committed only) ──────────────────────
      {
        // LLM-judged, so a warn (an identical retry could differ; a warn nudges
        // without trapping the author). Encodes the test-case-quality rule:
        // atomic, reproducible, and judged against one observable expected
        // result so any runner reaches the same pass/fail verdict.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the scenario's prose, its `how_to_run` (preconditions + steps), and its expected result (`expected` / `expected_status`). PASS when it verifies ONE behavior or condition, states the preconditions and the steps to reproduce it, and names a single observable, checkable expected result — so any tester or agent who runs it reaches the same pass/fail verdict. FAIL with a reason when it is vague (e.g. `test login`), bundles several unrelated checks into one scenario, depends on hidden state a reader cannot set up, or has no observable expected outcome to judge against.",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: TEST_SCENARIO_COMMITTED_LIFECYCLES,
      },

      // ── Result quality (warn, committed only) ────────────────────────
      {
        // A run is only useful if a reader can tell what ran where, how it
        // turned out, and — on failure — what actually happened and where the
        // evidence is. LLM-judged warn. The environment matters because the same
        // scenario can pass in one browser/build and fail in another.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the run's prose and fields. PASS when it records the environment it ran against — for a website or app that means the browser and version, the operating system, the device or viewport, the build / release or commit, and the URL or environment (e.g. staging vs production) — names a clear outcome (passed, failed, blocked, or skipped), and, when it failed or was blocked, says what actually happened versus what was expected and links the evidence (screenshot, recording, console or network log) or the defect. FAIL with a reason when the outcome or the environment is missing, or a failure is recorded with no actual result and no evidence.",
          when_node_type: ["log"],
        },
        fires_when_node_lifecycle: TEST_SCENARIO_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only suggestions) ────────────────────────────
      {
        policy:
          "A test Doco has two halves. A scenario (an Eval) is the durable spec — what should be true and how to check it — and each run (a Log) is one execution of it. Don't overwrite a scenario with its latest result: record every run as a new Log so the history of passes, failures, and the environments they happened in is preserved.",
      },
      {
        policy:
          "Give each scenario a clear objective in its prose (the one behavior or condition under test), the preconditions and ordered steps in `how_to_run`, the test data it needs, and a single observable expected result in `expected` (with a coarse `expected_status` of pass or fail). Keep it atomic — one behavior per scenario — independent of other scenarios, and deterministic, so it passes or fails for exactly one reason.",
      },
      {
        policy:
          "Keep the scenario's at-a-glance verdict on the Eval itself — `last_status` (pass / fail / pending), `last_run_at`, and `last_reason` as a cache of the most recent run — and keep the full, append-only history as Log nodes. The Eval answers “is it green right now?”; the Logs answer “how has it behaved over time and across environments?”.",
      },
      {
        policy:
          "Trace every scenario to what it verifies: `supports` the objective (Intent) it serves or the requirement / acceptance criterion (Reference) it checks, and group related scenarios under an objective or suite, nesting suites with `has_parent`. Traceability is what lets you answer “which tests cover this requirement, and are they green?”.",
      },
      {
        policy:
          "For websites and apps the same scenario can pass in one environment and fail in another, so record the environment on every run, not on the scenario: the browser and version, the operating system, the device or viewport, the build / release or commit under test, and the URL or environment (local, staging, production). Drive your browser / device matrix from real user analytics — cover the combinations your users actually use first.",
      },
      {
        policy:
          "Record a clear outcome on every run: passed, failed, blocked, or skipped. Use the node's `outcome` (succeeded / failed) for the pass/fail axis and state blocked or skipped in the run's prose. Distinguish failed from blocked: failed means a step did not meet its expected result but execution could continue; blocked means an earlier failure or an environment problem stopped the run before the scenario could be judged at all.",
      },
      {
        policy:
          "On a failure, capture what actually happened and attach the evidence — screenshots, a screen recording, console and network logs, or a stack trace — as Reference nodes linked with `supports`, and link the defect you filed (a GitHub issue, a Jira ticket) as a Reference with `relates_to`. This Doco is the test record, not the bug tracker: reference the external defect rather than re-litigating it here. When triaging, separate severity (how bad the failure is) from priority (how urgently it must be fixed).",
      },
      {
        policy:
          "For behavior specs, write the scenario as Given / When / Then — the preconditions as Given, the action as When, the single observable expected result as Then — across the scenario's prose and `how_to_run`. Keep it focused: one user-observable behavior per scenario and a single-digit step count. Split a vague “works on mobile” into concrete per-device scenarios that each pass or fail on their own.",
      },
      {
        policy:
          "Exploratory testing fits the same shape. Model a charter as an Intent — “Explore [area] using [approach] to discover [risks]” — run each time-boxed session as a Log that records what you did, what you found, what got in the way, and what is left (the PROOF debrief: Past, Results, Obstacles, Outlook, Feelings), and capture each bug as a Reference. Promote a recurring or important finding into an explicit Eval so it becomes a repeatable scenario.",
      },
      {
        policy:
          "Say how a scenario is run in `how_to_run` — the manual steps, or the command / suite id / spec path for an automated test — and attribute it to the Principal who owns it. A run is attributed to whoever (or whatever) executed it: a person, a CI pipeline, or an agent. Agents running a suite record each result as a Log here, so automated and manual runs share one history.",
      },
      {
        policy:
          "Walk a scenario through the lifecycle as it matures: `drafting` while you are still writing it, `queued` once it is ready to run or review, `active` when it is approved and part of the suite, and `retired` when the behavior is gone or the scenario is superseded — link the replacement with `replaces`. Completeness and quality gates apply once a scenario is committed (`queued` or `active`); a `drafting` sketch is spared. A run is a fact that already happened — record it as `active`.",
      },
      {
        policy:
          "The same Eval-plus-Log shape stretches to specialized tests without new node types — choose the Eval's `criterion` (an exact match, a response / shape match, or an llm-judge for fuzzy output) and put the specifics in the expected result and `how_to_run`: a performance test states a latency or throughput threshold as the expected result and logs the measured number; an accessibility test names the WCAG criterion and attaches the audit (e.g. an axe report) as evidence; a security test references the advisory or CVE; an API or contract test pins the expected response shape; a visual-regression test attaches the baseline and the diff. Reach for a different Doco only when what you are documenting stops being “a scenario and its runs”.",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write with `POST /<handle>/api/changesets.json` — create each scenario as an Eval with its `how_to_run`, `expected`, and `criterion`, wire its `supports` edge to the objective or requirement it covers, and record each run as a Log with the environment and outcome, its `supports` edge to the scenario, and any evidence References — all in one changeset, never as disconnected nodes.",
      },
    ],
  },
  {
    // Idea tracker — capture and track product ideas from raw jot to honest
    // verdict. The shape distills the durable consensus of idea-management
    // practice (Aha! / ProdPad / Ideawake-style funnels, Teresa Torres'
    // opportunity solution trees, Intercom's RICE and Sean Ellis' ICE scoring,
    // close-the-loop feedback practice, and Basecamp's Shape Up counterweight)
    // onto Doco's primitives, around one deep abstraction:
    //
    //   AN IDEA IS A CANDIDATE SOLUTION AWAITING AN HONEST VERDICT.
    //
    // That is already the `idea` node — `prose` is the proposal, `proposer_id`
    // credits who raised it, and the two native disposition fields
    // (`promoted_to` / `rejection_reason`) carry how it ended — so the template
    // needs NO new node type: it cultivates the existing Idea exactly as bugs
    // cultivates Eval and the glossary cultivates Reference. Every other
    // template's allowlist excludes Idea ("Ideas live in their own home until
    // promoted"); this template IS that home.
    //
    // The funnel rides on the lifecycle:
    //   - `drafting` = the INBOX and the PARKING LOT. Capture is frictionless
    //     and never blocked: a raw one-liner in the proposer's own words is a
    //     valid jot. A consciously parked idea also lives here, carrying a
    //     dated `rejection_reason` note saying what would revive it.
    //   - `queued`   = TRIAGED. Reviewed on a cadence, deduplicated, its
    //     problem framed, a shepherd named. Worth evaluating.
    //   - `active`   = IN EVALUATION. The few ideas the team is actually
    //     spending attention on: scoring, discovery, validation experiments.
    //   - `retired`  = CLOSED, with the disposition on the node: promoted
    //     (`promoted_to` points at what it became — a roadmap bet, a decision,
    //     a delivery) or rejected (`rejection_reason` says why, durably).
    //
    // Three disciplines the gates encode, each traceable to the literature:
    //   - SEPARATE THE PROBLEM FROM THE SOLUTION (made structural). The prose
    //     is the proposal; a committed idea must also carry the `problem` — the
    //     user/business need behind it, ideally in the proposer's words. Ideas
    //     are candidate solutions; the problem is the durable part, and a
    //     "problem" that merely restates the solution as a lack ("we don't
    //     have feature X") is the classic antipattern the quality judge names.
    //   - ONE CANONICAL RECORD PER IDEA, demand accumulated on it. Duplicates
    //     are retired with a `replaces` edge from the canonical idea; every
    //     repeated request is a Log in the demand stream (`supports`), so
    //     frequency and recency are read off the stream instead of a vote
    //     tally fragmenting across near-duplicates.
    //   - IDEAS CLUSTER UNDER OPPORTUNITIES (the opportunity-solution-tree
    //     move). An Intent is an opportunity — a problem, need, or outcome
    //     worth solving — and an idea `has_parent`-links to the ONE target
    //     opportunity it serves; competing ideas under one opportunity is
    //     healthy and explicit. The link is a warn (recommended), the
    //     single-target cap a block.
    //
    // The supporting cast: a Principal is the shepherd accountable for moving
    // a committed idea (a person or an agent); References carry the evidence
    // (feedback quotes, research, analytics, competitor moves); Logs are the
    // demand stream; an Eval is an assessment — a scoring pass or a validation
    // experiment — that `supports` the idea it tests; a Rule captures the
    // team's evaluation criteria (ICE, RICE, effort/impact — the framework is
    // the team's choice, not the template's) linked via `constrained_by`.
    //
    // Out of scope, kept in sibling Docos: the roadmap bet an idea becomes
    // (product-roadmap), the decision record behind a big call
    // (product-decisions), and delivery work (process). `promoted_to` is a
    // soft cross-Doco pointer, so promotion links the sibling without
    // absorbing it.
    name: "ideas",
    label: "Ideas",
    icon: "💡",
    description:
      "Capture and track product ideas — each separates the problem from the proposed solution, accumulates demand and evidence on one canonical record, is evaluated against explicit criteria, and ends with an honest disposition: promoted, parked, or rejected with the reason. Grounded in idea-management practice (opportunity solution trees, ICE/RICE scoring, close-the-loop feedback).",
    // An idea is jotted before it is triaged, so new nodes default to
    // `drafting` and the completeness/quality gates spare the inbox.
    defaultNodeLifecycle: "drafting",
    // An idea tracker is fundamentally a filterable funnel of records, so open
    // the overview on the built-in List perspective. (Graph stays behind it.)
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership (soft semantic gate) ──────────────────────────────
      {
        // Warn, not block: the author opted into the idea tracker, so this only
        // surfaces "this isn't really an idea / an opportunity" for
        // reconsideration. It steers defects to the bug tracker, scheduled work
        // to the backlog or a process Doco, and raw complaints into the
        // evidence stream (a Reference or Log) rather than the idea list. The
        // supporting cast — owners (Principal), criteria (Rule), evidence
        // (Reference), demand (Log), assessments (Eval) — is exempt by
        // omission from `when_node_type`.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in an idea tracker when it is an Idea — a candidate solution someone proposes (a feature, an improvement, an experiment, a new offering: something a team could choose to pursue) — or an Intent naming the opportunity ideas serve: a problem, unmet need, or desired outcome worth solving. PASS when the candidate is one of these. FAIL when it is instead a defect report (expected-vs-actual broken behavior — that belongs in a bug tracker), a committed task or scheduled work item (that is a backlog or process Doco), a raw complaint or feedback quote with no proposal in it (record it as evidence supporting an idea, not as the idea), or — for an Intent — a feature dressed up as an opportunity: an opportunity names a problem or outcome, never a solution.",
          when_node_type: ["idea", "intent"],
        },
      },
      {
        // Deterministic node-type allowlist. An idea tracker is the ideas
        // themselves plus the cast that gives each one meaning. Delivery steps
        // (Action), milestones (State), and decision records (Decision) belong
        // in their own Docos — an idea that graduates into any of them is
        // promoted there and linked via `promoted_to`, not modeled here.
        policy:
          "Only Idea, Intent, Eval, Log, Reference, Rule, and Principal belong in an idea tracker. An Idea is a candidate solution awaiting a verdict — its prose is the proposal, its `problem` the need behind it, and `promoted_to` / `rejection_reason` how it ended. An Intent is an opportunity (a problem, need, or outcome worth solving) that ideas cluster under; an Eval is an assessment — a scoring pass or validation experiment; a Log is one demand event (someone asked for this again); a Reference carries evidence (feedback, research, data, competitor moves); a Rule states the evaluation criteria; a Principal is the shepherd accountable for moving an idea. Delivery steps, milestones, and decision records belong in their own Docos — promote an idea there instead.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["idea", "intent", "eval", "log", "reference", "rule", "principal"],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist).
        // An idea tracker wires evidence, demand, ownership, opportunity
        // grouping, criteria, dedup, provenance, and see-also links — never
        // process sequence flow.
        policy:
          "Only these relationship edge types may be used in an idea tracker: `has_parent` (an idea → the ONE opportunity Intent it serves; a narrower opportunity → its broader opportunity or outcome), `supports` (evidence References, demand Logs, and assessment Evals → the idea they back, request, or test), `attributed_to` (an idea or opportunity → the Principal who shepherds it), `constrained_by` (an idea or opportunity → a Rule stating the evaluation criteria or a strategic guardrail), `relates_to` (a see-also or dependency between related or competing ideas), `replaces` (the canonical idea supersedes a duplicate), and `derived_from` (an idea → the demand Log, feedback Reference, or prior idea that sparked it). Process sequence flow (`flows_to`) describes delivery, not ideation, and has no place here.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "has_parent",
            "supports",
            "attributed_to",
            "constrained_by",
            "relates_to",
            "replaces",
            "derived_from",
          ],
        },
      },

      // ── Completeness: the problem behind the proposal (block, committed) ──
      {
        // The separate-problem-from-solution discipline made structural — the
        // exact move the glossary makes with `definition` and the FAQ with
        // `answer`. A `drafting` inbox jot may be a bare one-liner; an idea a
        // team has committed attention to states the need it serves, so a
        // reviewer can judge the problem even when the proposed solution is
        // weak. (`problem` lives in the node's `extra` bag, which the
        // evaluator reads as a field.)
        policy:
          "Every committed (`queued` or `active`) idea carries a `problem` — the user or business need behind the proposal, ideally in the proposer's own words. The prose is the candidate solution; the `problem` is the durable part a reviewer evaluates. A `drafting` inbox jot may capture the proposal first and frame the problem at triage.",
        predicate: {
          kind: "requires_field",
          fields: ["problem"],
          when_node_type: ["idea"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },

      // ── Accountability: a shepherd (block, committed) ─────────────────
      {
        // An idea under consideration without an owner rots in the funnel. A
        // committed idea names the Principal — a person or an agent —
        // accountable for moving it to a verdict, mirroring the bug-owner and
        // FAQ-steward gates. A `drafting` jot may arrive ownerless.
        policy:
          "Every committed (`queued` or `active`) idea is attributed to the Principal who shepherds it — an `attributed_to` edge from the idea to that Principal — accountable for moving it to an honest verdict: promoted, parked, or rejected. An idea in evaluation with no shepherd rots in the funnel. A `drafting` inbox jot may arrive ownerless.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["idea"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },

      // ── Opportunity placement: floor (warn) + ceiling (block) ─────────
      {
        // The opportunity-solution-tree floor, surfaced as a WARN, not a
        // block: linking each committed idea to the opportunity it serves is
        // strongly recommended (ideas divorced from problems are noise), but
        // teams triage real ideas before their opportunity map exists, so the
        // nudge must not trap the write. (Mirrors the bug template's
        // severity/priority deterministic warn.)
        on_violation: "warn",
        policy:
          "A committed (`queued` or `active`) idea names the opportunity it serves — a `has_parent` edge to the Intent for that problem, need, or outcome — so competing ideas for one opportunity sit side by side and can be compared. Strongly recommended and surfaced as a warning, not enforced: an idea may be triaged before the opportunity map exists.",
        predicate: {
          kind: "requires_edge",
          edge_type: "has_parent",
          target_node_type: "intent",
          direction: "outgoing",
          when_node_type: ["idea"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },
      {
        // The CEILING that complements the floor above: a committed idea
        // serves AT MOST one target opportunity. An idea pinned to two
        // opportunities is unevaluatable — its impact and its competitors are
        // ambiguous; split it, or pick the primary opportunity. A `drafting`
        // sketch is exempt. Re-point by retiring the old `has_parent` edge
        // before adding the new one; endpoints are immutable.
        policy:
          "Every committed (`queued` or `active`) idea serves AT MOST one target opportunity: it carries at most one `has_parent` edge to an Intent. An idea pinned to two opportunities can't be evaluated — its impact and its competitors are ambiguous. Split it into one idea per opportunity, or pick the primary one. A `drafting` sketch is exempt.",
        predicate: {
          kind: "limits_edge",
          edge_type: "has_parent",
          target_node_type: "intent",
          max_count: 1,
          when_node_type: ["idea"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },

      // ── The assessment spine (block, committed) ───────────────────────
      {
        // An assessment must assess something: a committed Eval links the idea
        // it scores or tests with a `supports` edge — the same dangling-result
        // gate the roadmap and evals templates carry. Without it the verdict
        // is an orphaned number.
        policy:
          "Every committed (`queued` or `active`) assessment links to the idea it assesses — a `supports` edge from the Eval to that idea. An assessment that assesses nothing is an orphaned verdict; the edge is what lets the tracker show how an idea earned its evaluation. A `drafting` assessment may defer the link.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },

      // ── Idea quality (probabilistic, warn, committed) ─────────────────
      {
        // LLM-judged, so a warn (an identical retry could differ; a warn
        // nudges without trapping the author). Encodes one-idea-per-record and
        // the real-problem discipline, naming the classic antipattern: a
        // "problem" that merely restates the proposal as a lack.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the idea's prose (the proposal) and its `problem`. PASS when the prose pitches ONE concrete, actionable proposal and the `problem` states a real user or business need — who has it, what the pain is, and why it matters — that would still be worth solving if this particular proposal died. FAIL with a reason when the record bundles several distinct proposals (split them and link with `relates_to`), when the proposal is too vague to evaluate (`make the product better`), or when the `problem` merely restates the proposal as a lack or absence (`we don't have feature X`, `users can't do X yet`) instead of naming the need behind it.",
          when_node_type: ["idea"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },

      // ── Assessment quality (probabilistic, warn, committed) ───────────
      {
        // The evaluate-with-evidence discipline: a verdict is auditable only
        // when its method and inputs are visible. LLM-judged warn.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the assessment's prose and fields. PASS when the assessment shows its work: it names the method (a scoring pass against stated criteria such as ICE/RICE with the per-factor inputs, or a validation experiment such as a prototype test, painted-door, or interview round with what was run and observed) AND a verdict or recommendation a reader could challenge — validated / invalidated / score with what follows from it. FAIL with a reason when it is a bare gut call (`feels high-impact`), a score with no inputs to audit, or an experiment with no observed result.",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: IDEA_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only suggestions) ─────────────────────────────
      {
        policy:
          "Keep capture frictionless — the inbox is sacred. Anyone (or any agent) jots an idea the moment it occurs, as a `drafting` node in the proposer's own words, without a perfect pitch: a bare one-liner is a valid jot. Credit the proposer — set `proposer_id` to their real user id when they are an in-product user (it references the users table; an invented id fails the write), or name an outside source (a customer, a sales call) in the prose or `problem`. Ideas die in unsent drafts, not in triage.",
      },
      {
        policy:
          "Keep one idea per record. Each Idea is exactly one proposal, so it can be evaluated, promoted, or rejected on its own; split a record that bundles several proposals and connect the parts with `relates_to`. Variants of one proposal stay on the canonical record (note them in the prose) rather than spawning siblings.",
      },
      {
        policy:
          "Separate the problem from the solution. The prose is the candidate solution; the `problem` field is the user or business need behind it — who has it, what the pain is, why it matters, ideally in the proposer's own words. The problem is the durable part: solutions are cheap and interchangeable, and a strong problem with a weak proposal is a better record than the reverse. Never write the problem as the solution restated as a lack (`we don't have X`).",
      },
      {
        policy:
          "Dedupe to one canonical idea. Search before filing; when a duplicate arrives anyway, fold its wording and evidence into the canonical record, retire the duplicate, and link the canonical idea to it with a `replaces` edge (the `supersede` changeset op does both at once) — so demand consolidates onto one record instead of fragmenting across near-duplicates.",
      },
      {
        policy:
          "Record demand as a stream, not a tally. Every time someone asks for an idea again — a support ticket, a sales call, a forum thread — capture it as a Log (who asked, when, in what context, how acute) with a `supports` edge to the idea. A demand event is a fact that already happened, so record it as `active` (the Doco-wide `drafting` default is for ideas, not facts); the same goes for evidence References. Frequency, recency, and who's asking are then read off the stream, which is the evidence a prioritization call needs; a vote count on the node tells you none of that. When a request arrives that no tracked idea covers, the orphan Log is the signal to write one — link the new idea `derived_from` the Log that sparked it.",
      },
      {
        policy:
          "Ground ideas in evidence. Link the feedback quotes, research, analytics, and competitor moves behind an idea as References with `supports` edges, and mark provenance with `derived_from` when the idea grew directly out of a finding. An idea backed by evidence can be evaluated; an opinion can only be argued with.",
      },
      {
        policy:
          "Cluster ideas under opportunities — the opportunity-solution-tree shape. Model each problem, unmet need, or desired outcome as an Intent, nest narrower opportunities under broader ones with `has_parent`, and link each idea to the ONE target opportunity it serves. Several competing ideas under one opportunity is healthy: it makes 'compare and combine before you commit' the default reading, and it keeps solutions tied to the problems that justify them.",
      },
      {
        policy:
          "Triage on a cadence — weekly or biweekly — rather than on arrival or never. Triage is where a jot earns commitment: dedupe it, frame its `problem`, name its shepherd (`attributed_to` a Principal — a person or an agent), link its opportunity, and move it to `queued` — or park or reject it honestly. An inbox that only ever grows is where ideas go to die.",
      },
      {
        policy:
          "Evaluate against explicit criteria, and show your work. Capture the team's rubric — ICE, RICE, value-vs-effort, strategic fit, whatever your team trusts — as a Rule linked with `constrained_by`, and record each scoring pass or validation experiment (a prototype test, a painted-door, an interview round) as an Eval that `supports` the idea, carrying its inputs and verdict so the ranking stays auditable. Test before you invest: a cheap experiment beats a confident opinion, and an invalidating result is a success — it killed a bad bet for the price of a test.",
      },
      {
        policy:
          "Walk an idea through the funnel on its lifecycle: `drafting` is the inbox and the parking lot (a jot may be a bare one-liner), `queued` is triaged (deduped, problem framed, shepherd named), `active` is in evaluation (the few ideas actually being scored and validated — keep this set small), and `retired` is closed. Completeness and quality gates apply once an idea is committed (`queued`/`active`); the inbox is spared.",
      },
      {
        policy:
          "Close every idea with an honest disposition, and close the loop with the proposer. Promote: record what the idea became in `promoted_to` — the roadmap bet (Intent), decision record, or delivery work it turned into, usually in a sibling Doco — then retire it. Reject: retire with a written `rejection_reason` that is kind, specific, and durable (future proposers of the same idea will find it; offer the alternative when one exists). Park: keep it `drafting` with a dated `rejection_reason` note saying what would revive it (a demand threshold, a dependency landing). In every case, tell the proposer what happened and why — an idea that dies of silence costs you every idea that person never files again.",
      },
      {
        policy:
          "Prune rather than hoard — the pipeline is not a commitment. An idea nobody has touched in months gets retired with an honest reason, not kept 'just in case': a backlog of a thousand stale ideas is worse than none, because nobody trusts or reads it. Trust resurrection over hoarding — a good idea will come back with fresh demand (and its retired record, found by the next proposer, carries the context forward).",
      },
      {
        policy:
          "Agents: read `GET /<handle>/api/authoring-contract.json` and write with `POST /<handle>/api/changesets.json`. Capture a jot as a bare `drafting` Idea; at triage, set its `problem`, and add its `attributed_to` shepherd and `has_parent` opportunity edges in the same changeset. Log each repeated request as an `active` Log with a `supports` edge to the canonical idea (use `supersede` to fold duplicates), record each assessment as an Eval together with its `supports` edge to the idea it assesses in one changeset, and close by patching `promoted_to` or `rejection_reason` and retiring — never by deleting.",
      },
    ],
  },
  {
    // Agents chats — the record of every chat an agent has with a user. The
    // baseline duties have each agent capture one Log per chat here before the
    // chat ends. Only Logs belong: what a chat produced (a Decision, an Idea, a
    // bug) goes in the Doco that holds that kind of knowledge, and edges don't
    // cross Docos, so the Log lists those nodes' ids in its `outputs`.
    name: "agents-chats",
    label: "Agents chats",
    icon: "🤖",
    description:
      "Record every chat an agent has with a user — who took part, what was asked, what was worked on, what came of it, and what was left open — one Log per chat, pointing to the decisions and work it produced.",
    // A chat record is read newest first, as a list.
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      {
        policy:
          "Only Logs belong here: one per chat. What a chat produced goes in the Doco that holds that kind of knowledge — a Decision in the Product decisions, Design decisions or Architectural decisions Doco (and, when it is about a business process, in Processes too), an idea in Ideas, a bug in the Bug tracker — and the chat's Log points to it.",
        predicate: { kind: "requires_node_type", node_types: ["log"] },
      },
      {
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A chat Log names who took part (the user by name, the agent by its credential label), what the user asked for, what was worked on, what came of it, and what was left open. Pass when all five are clear from the Log; fail when any is missing or vague.",
          when_node_type: ["log"],
        },
      },
      {
        policy:
          'Capture the Log before the chat ends, with `verb` "chatted", `happened_at` when the chat began, and `prose` that summarizes the chat in the third person. Summarize rather than transcribe; quote the user only where the exact words matter, such as a requirement, a correction or an approval.',
      },
      {
        policy:
          'List what the chat produced in the Log\'s `outputs`: the ids of the nodes it captured in other Docos (decisions, ideas, bugs, actions) and the pull requests, issues or documents it touched. A chat that produced nothing says so, for example `{ "produced": "nothing" }`.',
      },
      {
        policy:
          "When a chat picks up where an earlier one left off, link its Log to the earlier Log with `relates_to`, so a long piece of work reads as one thread.",
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
