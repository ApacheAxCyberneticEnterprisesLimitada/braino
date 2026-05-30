/**
 * Default Doco templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships curated templates. `global` is the policies
 * template; the others describe common Doco shapes such as business
 * processes, glossaries, and org charts. Per the successor to
 * decision_01KRFG5BAJ1ATHX0QE0HHX0QEV (which trimmed thirteen
 * templates down to two) — every other previously-shipped template
 * stays project-owner-authored. Template names are plain handles.
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
 * v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) drops the
 * `kind: "authoring"` value from RuleKind. Templates no longer mark
 * policies "authoring" explicitly. Templates now store those
 * meta-constraints as policies instead of overloading
 * Rule.
 */
import type { AuthoringPredicate, Lifecycle } from "@doco/shared";

export interface TemplatePolicy {
  /**
   * Policy kind on the seeded policy. Optional —
   * defaults to "tagged" when `predicate` is set, "guidance" otherwise.
   * v7 dropped "authoring" (decision_01KRRR5BQ16ASY8HQEE0V499YG).
   */
  kind?: "guidance" | "tagged";
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
        kind: "guidance",
        policy:
          "Capture each meaningful decision, correction, and load-bearing implementation outcome in Doco.",
      },
      {
        kind: "guidance",
        policy: "If you're an agent, check with your client before changing the policies.",
      },
      {
        kind: "guidance",
        policy:
          "AI agents: document every explicit rule and decision from the project owner, and especially every correction. Corrections are the highest-signal moments — they encode preferences that aren't visible in the code or docs. Capture them in Doco the same turn they happen, so the next agent (or the next session of you) doesn't repeat the mistake.",
      },
      {
        kind: "guidance",
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
    // Glossaries define product and domain language. Each active term
    // entry is a Decision: `question` names the concept, `chosen` is the
    // canonical term, and `decision` holds the definition, scope, and
    // examples. List is the natural authoring surface for terminology.
    name: "glossaries",
    label: "Glossaries",
    icon: "📚",
    description:
      "Document product and domain terminology — canonical terms, definitions, aliases, deprecated wording, sources, and consistency checks.",
    defaultNodeLifecycle: "drafting",
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
        policy:
          "A glossary Decision defines one concept. Split entries that define multiple independent terms or concepts.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "Read the Decision's `question`, `chosen`, and `decision` prose. PASS when the entry defines one concept or one canonical term. FAIL with a reason when it defines multiple independent terms, bundles a term with an unrelated policy, or uses one entry as a catch-all for several concepts.",
        },
      },
      {
        policy:
          "An active glossary Decision's `decision` prose includes a concise definition, product/domain scope, and at least one example or non-example.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "Read the Decision's `decision` prose. PASS when it includes (1) a concise definition, (2) the product or domain scope where the term applies, and (3) at least one concrete example or non-example. FAIL with which element is missing when the prose is too vague for a reader to use the term consistently.",
        },
        fires_when_node_lifecycle: ["asserted"],
      },
      {
        policy:
          "Acronyms and abbreviations in glossary entries spell out the expanded form and state when the short form is acceptable.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "Inspect the Decision's `chosen` term and `decision` prose. PASS when acronyms or abbreviations are expanded at least once and the prose states whether the short form is acceptable in product/docs/UI copy. If there are no acronyms or abbreviations, PASS. FAIL when a short form appears without expansion or usage guidance.",
        },
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
        kind: "guidance",
        policy:
          "When rejected, deprecated, misleading, synonymous, or historical terms exist, record them in `alternatives`; otherwise omit `alternatives` rather than inventing filler.",
      },
      {
        kind: "guidance",
        policy:
          "When two distinct concepts share a surface form (homographs, e.g. `Order` in commerce vs. `Order` as a sort operation), give each its own Decision and disambiguate `chosen` with a qualifier — `Order (commerce)` vs. `Order (sorting)` — so every entry stays uniquely addressable.",
      },
      {
        kind: "guidance",
        policy:
          "Connect related glossary terms in the graph instead of leaving entries isolated — link a term to the broader concept it specializes, to the narrower terms beneath it, and to terms it is easily confused with, so the vocabulary reads as a navigable network. Deprecation links use `superseded_by` (see below).",
      },
      {
        kind: "guidance",
        policy:
          "Borrowed, standards-based, or industry terms cite a Reference when possible. Product-internal terms state that they are product-specific so readers don't mistake them for external standards.",
      },
      {
        kind: "guidance",
        policy:
          "Retired glossary Decisions point at the replacement term via `superseded_by` when one exists, and keep the deprecated term visible so readers understand old docs, tickets, or UI copy.",
      },
      {
        kind: "guidance",
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
        kind: "guidance",
        policy:
          "A business process has ≥1 active initial State and ≥1 active terminal State, with each `state` name unique within the process. Every process starts somewhere, ends at a business outcome (or an explicitly cancelled outcome), and names its milestones unambiguously.",
      },
      {
        kind: "guidance",
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
        kind: "guidance",
        policy:
          "Model a repeatable business process that produces a business outcome — not a UI journey, a code path, an incident, or a pure state machine. UI journeys and pure state machines belong in their own Docos.",
      },
      {
        kind: "guidance",
        policy:
          "Use one linked Intent per concrete process when the Doco is large. Split on a durable ownership boundary, reuse across multiple parents, or pure readability.",
      },
      {
        kind: "guidance",
        policy:
          "When a step is itself a whole sub-process, model it as its own child process Intent and link the calling Action to that Intent (the BPMN call-activity pattern) instead of inlining dozens of Actions. The BPMN view collapses the child Intent into its own pool, keeping the parent process readable.",
      },
      {
        kind: "guidance",
        policy:
          "Name the single accountable process owner in the purpose Intent — the Principal answerable for the whole process's outcome. This is the RACI 'Accountable' role, distinct from the per-step 'Responsible' actors named in each Action's `actor_id`.",
      },
      {
        kind: "guidance",
        policy:
          "Agents should read `GET /<handle>/api/authoring-contract.json` and write structured flows with `POST /<handle>/api/changesets.json`; create flow nodes with their incoming `sequence_flow` edge in the same changeset instead of creating disconnected nodes.",
      },
      {
        kind: "guidance",
        policy:
          "Use `relate_many` for sibling edges that must be valid together, especially exhaustive gateway branches. Adding one branch at a time can create a temporarily invalid BPMN graph.",
      },
      {
        kind: "guidance",
        policy:
          "BPMN vocabulary: use `sequence_to` for forward process flow; it materializes as `sequence_flow` and renders source -> target with no reversal. Use `intent_ids`/`serves` for pool membership, `gated_by` for policy guards, and `decision_ids` only for rationale/provenance associations.",
      },
      {
        kind: "guidance",
        policy:
          "`sequence_to` may be a list of target ids or objects like `{ target, label, condition, kind }`. Put gateway branch labels and default/exception/timer metadata on the outgoing edge, not by reversing a relationship from the downstream Action back to the Decision.",
      },
      {
        kind: "guidance",
        policy:
          "For parallel work, give one flow node multiple unconditional `sequence_to` targets — an AND-split needs no gateway Decision. Reserve gateway Decisions for exclusive or conditional (XOR/inclusive) branching, and reconverge parallel branches on a shared downstream node.",
      },
      {
        kind: "guidance",
        policy:
          "Rework and retry loops are allowed: a `sequence_to` may target an earlier flow node to send work back (revise-and-resubmit, fix-and-recheck). Route the loop back through a gateway Decision so the cycle has an explicit exit and can't spin forever. A single edge still renders source -> target — a loop is about where the edge points, not reversing its direction.",
      },
      {
        kind: "guidance",
        policy:
          'Model the unhappy path. Use `sequence_to` objects with `kind: "exception"` or `kind: "timer"` to route failures, rejections, and timeouts to a recovery step or an explicitly cancelled terminal State, so the process documents what happens when the happy path does not hold.',
      },
      {
        kind: "guidance",
        policy:
          "Edges are first-class: a `serves`, `sequence_flow`, or `gated_by` edge has its own lifecycle and history, and its endpoints are immutable. To reroute the process — send a step to a different next step, or move an Action under another Intent — retire the old edge and add the new one instead of editing endpoints in place. Nothing is deleted; the previous wiring stays recoverable with the reason it changed.",
      },
      {
        kind: "guidance",
        policy:
          "Drafting nodes may be incomplete while the process is being sketched. Move flow nodes and the purpose Intent to `asserted` only after actor assignments, Intent links, and forward `sequence_to` wiring are coherent.",
      },
      {
        kind: "guidance",
        policy:
          "Process *instances* (recorded runs) live in a separate Doco as Logs; surface them here only via References. This template describes the design of the process, not the history of its executions.",
      },
      {
        kind: "guidance",
        policy:
          "Rules in a business-processes Doco are process policies and guards (`refunds above $5k require manager approval`). Template-authoring rules — meta-rules about how to write process Docos — belong in the template or in `global`, not in any process using it.",
      },
      {
        kind: "guidance",
        policy:
          "Don't model every click, method call, or DB mutation — only the steps that mean something to a business operator. Implementation detail belongs in `apis` or code Docos, not here.",
      },
    ],
  },
  {
    // Organizational chart template. Principals are the org *seats*
    // (a role plus its current occupant), `reports_to` edges form the
    // primary hierarchy, Intents represent teams/units, Decisions
    // record reorgs and appointments. After the Principal slim-down
    // (decision_01KSDR_PRINCIPAL_SLIM_DOWN) a Principal carries only
    // `name` + `body_md`; the person / AI-agent / vacant distinction
    // lives in the body_md prose, enforced by a probabilistic policy
    // rather than a `requires_field` check.
    //
    // Industry alignment (W3C Organization Ontology + HR practice):
    // a seat that can stand vacant approximates `org:Post`; secondary
    // (dotted-line / matrix) reporting layers on top of the single
    // primary `reports_to` line via guidance, since the Principal
    // schema carries exactly one manager. A fully structural
    // Post/Membership split (separate occupant nodes, a versioned
    // `member_of` / `held_by` edge, a real vacancy field) would need a
    // schema change beyond this template and is intentionally left as a
    // follow-up rather than half-modeled here.
    name: "org-chart",
    label: "org-chart",
    icon: "🏢",
    description:
      "Map the people and AI agents in an organization — reporting lines, teams, roles, and appointments. Every seat declares in its `body_md` prose whether it's filled by a person, filled by an AI agent, or currently vacant.",
    defaultNodeLifecycle: "drafting",
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
        kind: "guidance",
        policy:
          "An org chart describes who reports to whom and which teams exist — not what those people do. Activities, processes, and workflows belong in business-processes Docos linked via Reference.",
      },
      {
        kind: "guidance",
        policy:
          "`reports_to` chains must not be circular. A cycle (A reports to B, B reports to C, C reports to A) usually means a refactor in progress; resolve it before activating the affected Principals. The framework evaluator can't check this yet — it's a manual review.",
      },
      {
        kind: "guidance",
        policy:
          "AI-agent Principals that act on a human's behalf should declare that human via prose in `body_md` (`Operates under: @alice`), or via a `delegated_by` Decision linking the human Principal to the agent Principal. Autonomous agents (no human owner) state that explicitly so readers know the accountability stops at the agent.",
      },
      {
        kind: "guidance",
        policy:
          "Capture reorgs, hires, departures, and role changes as Decisions, and link the affected Principals via `decision_ids`. Org charts churn; without Decisions, the history of WHY a reporting line moved is lost.",
      },
      {
        kind: "guidance",
        policy:
          "Team membership lives in the Intent's `actors` list, which the org-tree renders but does not version. When someone joins or leaves a team, record it as a Decision linking the affected Principals so the *why* and *when* survive the in-place edit. Once a Doco needs real join/leave history, prefer a first-class `member_of` edge over editing `actors`, mirroring how `reports_to` is already a versioned edge — an `actors` array overwrite leaves no trail.",
      },
      {
        kind: "guidance",
        policy:
          "`reports_to` is a first-class edge with its own lifecycle and history, and its endpoints are immutable. When a reporting line moves, retire the old `reports_to` edge and add the new one rather than rewriting it in place — the prior line stays recoverable alongside the Decision that explains the reorg.",
      },
      {
        kind: "guidance",
        policy:
          "`reports_to` carries exactly one manager — the primary (solid-line) reporting relationship — so the org tree stays a clean hierarchy. Model secondary, dotted-line, or matrix reporting on top of it: use a `dotted_reports_to` association edge, or a Decision when the matrix assignment needs rationale (project lead, functional vs operational manager). Don't overload `reports_to` with a second manager — it breaks the primary tree the perspective draws.",
      },
      {
        kind: "guidance",
        policy:
          "Use Intents to model teams, departments, and org units. The Intent's `intent` field names the unit's mandate; `actors` lists the member Principals; `stakeholders` lists the people who care about the unit's outcomes without being on the team.",
      },
      {
        kind: "guidance",
        policy:
          "Model load-bearing roles and recurring positions — not every contractor, intern, or one-day visitor. If a seat would be empty in three months, it probably belongs in a sibling Doco or a Reference rather than as a Principal here.",
      },
      {
        kind: "guidance",
        policy:
          "Treat each Principal as a seat — a role plus its current occupant — not just a person. A budgeted-but-unfilled seat is a valid Principal: declare it `vacant` in `body_md`, name the role it's budgeted for, and keep its `reports_to` line so the tree stays complete. Omitting open roles hides headcount and distorts the reporting structure (the same mistake as leaving vacant boxes off a printed chart).",
      },
      {
        kind: "guidance",
        policy:
          "Person vs agent isn't about who signed in — it's about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any User has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.",
      },
      {
        kind: "guidance",
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
 * `glossaries`, `business-processes`, `org-chart`).
 */
export function findDocoTemplateByName(name: string): DocoTemplate | undefined {
  return DEFAULT_DOCO_TEMPLATES.find((t) => t.name === name);
}
