/**
 * Default Doco templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships curated templates. `global` is the policies
 * template; the others describe common Doco shapes such as user flows,
 * state machines, tests, and business processes. Per the successor to
 * decision_01KRFG5BAJ1ATHX0QE0HHX0QEV (which trimmed thirteen
 * templates down to two) — every other previously-shipped template
 * stays project-owner-authored. Template names are plain handles.
 *
 * Each template ships:
 * - `description` — the description text rendered in the picker and
 *   bootstrap manifest.
 * - `policies` — at install time entries seed Doco-level
 *   policies: prose-only entries become guidance_policies;
 *   predicate-bearing entries become neuron_authoring_policies.
 * - `allowedNeuronTypes` (optional) — a Doco-level allowlist. `global`
 *   ships with policy types so the Doco's policy set is kept
 *   separate from domain Rule neurons.
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
   * neuron_authoring_policy so the check can run during capture.
   */
  predicate?: AuthoringPredicate;
  /**
   * v7: when set, the engine only fires this policy against
   * candidates whose `lifecycle` is in the list. Used by completeness
   * rules that skip drafting neurons during mid-construction.
   */
  fires_when_neuron_lifecycle?: Lifecycle[];
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
   * Optional perspectives to attach on Doco creation. The two
   * built-in perspectives (graph, list) are always attached even
   * if this list is empty; entries here append after them. The
   * business-processes template ships `[{slug:"bpmn"}]` so a Doco
   * created from that template arrives with the BPMN tab ready.
   */
  perspectives?: TemplatePerspectiveAttachment[];
  /**
   * Doco-level allowlist for captured neuron types. `global` keeps the
   * Doco policy set focused by accepting only policy types.
   */
  allowedNeuronTypes?: (
    | "decision"
    | "intent"
    | "action"
    | "rule"
    | "guidance_policy"
    | "neuron_authoring_policy"
    | "log"
    | "eval"
    | "reference"
    | "idea"
    | "state"
  )[];
  /**
   * When set, captures into a Doco created from this template default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The state-machines template uses
   * `"drafting"` so authors can sketch incomplete machines without
   * tripping completeness rules.
   */
  defaultNeuronLifecycle?: Lifecycle;
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
      "Your doco's global policies — guidance policies and neuron-authoring policies that govern how contributors work.",
    allowedNeuronTypes: ["guidance_policy", "neuron_authoring_policy"],
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
    // Per decision_01KRRD6QM7NN2EV56NZK96DNKY the user-flows template
    // collapses from six guidance rules to deterministic authoring
    // policies + a concise summary for picker/manifest surfaces.
    name: "user-flows",
    label: "user-flows",
    icon: "🌊",
    description: "Document end-to-end user journeys as ordered steps, branches, and decisions.",
    policies: [
      {
        // Membership check: probabilistic semantic gate, with a
        // deterministic node-type allowlist that excludes Rule. Rules
        // tagged into user-flows *govern* how journeys are authored;
        // they aren't themselves journey content, so subjecting them
        // to the journey-prose check would lock out the rules that
        // define the template's contract.
        policy:
          "A node belongs in user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature. (Rule nodes that govern user-flow authoring are exempt — they shape the template rather than journey content.)",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature.",
          when_neuron_type: ["intent", "action", "decision", "reference"],
        },
      },
      {
        policy:
          'Action nodes in user-flows pass the prose style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
        predicate: {
          kind: "probabilistic",
          spec: 'Action nodes in user-flows pass the prose style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
          when_neuron_type: ["action"],
        },
      },
      {
        policy:
          "Only Intent, Action, Decision, Reference, and Rule nodes belong to user-flows. Evals, Ideas, and Logs each have their own home.",
        predicate: {
          kind: "requires_neuron_type",
          neuron_types: ["intent", "action", "decision", "reference", "rule", "principal"],
        },
      },
      {
        policy:
          "Every Intent in user-flows must declare the principals who want the journey in the `actors` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actors"],
          when_neuron_type: ["intent"],
        },
      },
      {
        policy:
          "Every Action in user-flows must declare the principal who performs the designed step in the `actor_id` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_neuron_type: ["action"],
        },
      },
      {
        policy:
          "Every Decision in user-flows must declare the principal who owns the branch or choice in the `decided_by` field.",
        predicate: {
          kind: "requires_field",
          fields: ["decided_by"],
          when_neuron_type: ["decision"],
        },
      },
      {
        policy:
          "Every Action in user-flows must reference the journey Intent it advances (a `serves` edge to an Intent). Without it the flow renderer can't group steps into a coherent journey.",
        predicate: {
          kind: "requires_synapse",
          synapse_type: "serves",
          target_neuron_type: "intent",
          when_neuron_type: ["action"],
        },
      },
      {
        // user-flows v2: each principal listed on the Intent's
        // `actors` must be the actor_id of ≥1 Action serving the
        // Intent. Fires only when the Intent moves to `active` —
        // drafting Intents can be captured first and have their Actions
        // filled in after.
        policy:
          "Every principal listed in an Intent's `actors` must be the `actor_id` of at least one Action that `serves` the Intent. Fires when the Intent is active — drafting Intents are allowed to be incomplete.",
        predicate: {
          kind: "graph-completeness",
          list_field: "actors",
          synapse_type: "serves",
          incoming_neuron_type: "action",
          incoming_field_must_match: "actor_id",
          when_neuron_type: ["intent"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        // user-flows v2: actor_id must point at a real Principal —
        // rejects "the browser", "app.js", "the system" as actors.
        // System-internal steps belong in `apis` or `adrs`, not in a
        // user-flow. (Post-rename, person/agent distinction moved to
        // Collaborator; the engine just enforces principal resolution.)
        policy:
          "An Action's `actor_id` must resolve to an existing Principal. System-internal steps (the browser, a background job, a script) belong in `apis` or `adrs`, not in a user-flow.",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_neuron_type: ["action"],
        },
      },
    ],
  },
  {
    // Per decision_01KRRR5BQ16ASY8HQEE0V499YG (v7): formal state-machine
    // modeling. The template is pure data: atomic policies
    // policies plus Doco-level defaults. Framework policies the
    // rules use: State neuron + triggered_by / gated_by synapses +
    // drafting lifecycle + defaultNeuronLifecycle.
    name: "state-machines",
    label: "state-machines",
    icon: "🔁",
    description:
      "Track anything that moves through stages — orders, tasks, bug tickets, deploys. Each stage is a State; transitions are Actions.",
    defaultNeuronLifecycle: "drafting",
    policies: [
      // ── Always-on deterministic (fire on any node lifecycle) ──
      {
        // D1 — Idea and Log have their own homes elsewhere.
        policy:
          "Only State, Action, Decision, Eval, Reference, Intent, and Rule nodes belong to a state-machines doco. Other captures (Idea, Log) live elsewhere — Ideas are speculative until promoted; Logs capture recorded events rather than designed steps.",
        predicate: {
          kind: "requires_neuron_type",
          neuron_types: [
            "state",
            "action",
            "decision",
            "eval",
            "reference",
            "intent",
            "rule",
            "principal",
          ],
        },
      },
      // Aggregate process checks are tracked as guidance until the
      // evaluator can express them against a Doco-level process. The
      // semantics they encode —
      // alternation, terminal-state outgoing-edge bound, unique state
      // names, ≥1 initial/terminal — are tracked as descriptive
      // guidance below until a v16-shape evaluator lands.
      {
        policy:
          "`preceded_by` synapses alternate State ↔ Action — a transition Action is preceded by a State, and a State is preceded by the Action that produced it.",
        kind: "guidance",
      },
      {
        policy:
          "State `state` is unique within a state-machine doco — duplicate State names ambiguate transitions and break referential semantics.",
        kind: "guidance",
      },
      {
        policy:
          "Terminal States have no successor Action — no Action's `preceded_by` may point at a terminal State.",
        kind: "guidance",
      },
      {
        policy:
          "A `preceded_by` edge must point at a node in the same machine — a State / Action that has slipped out (or a typo'd id) breaks the chain.",
        kind: "guidance",
      },
      {
        policy:
          "An active state-machine doco must have ≥1 active State of kind `initial` — every machine starts somewhere.",
        kind: "guidance",
      },
      {
        policy:
          "An active state-machine doco must have ≥1 active State of kind `terminal`. Perpetual machines (worker loops, services) are the exception.",
        kind: "guidance",
      },
      {
        policy:
          "Each active initial State has ≥1 successor Action — otherwise the machine starts but never moves.",
        kind: "guidance",
      },
      {
        policy:
          "Each active intermediate State is the `preceded_by` target of ≥1 active Action — orphan intermediates (typos, dangling refactors) signal a wiring mistake.",
        kind: "guidance",
      },
      // ── Probabilistic ──
      // v7: each rule is gated to the node type it actually inspects so
      // the LLM judge isn't asked to evaluate, e.g., a State's summary
      // against a spec about compensating Actions.
      {
        // P1
        policy:
          "State `state` reads as a noun or past-participle, not an imperative verb. Acceptable: `paid`, `cart`, `cancelled`. Not: `Pay`, `Cancel`, `Process the order`.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["state"],
          spec: "Check ONLY the State's `state` field. It must read as a noun or past-participle naming the position the modeled entity occupies (`cart`, `paid`, `cancelled`, `awaiting-review`). It must NOT be an imperative verb naming an action (`Pay`, `Cancel`, `Process the order`). A single-word past-participle adjective is acceptable.",
        },
      },
      {
        // P2
        policy:
          "An Action that transitions between States names the event or command, not the destination state. Acceptable: `checkout submitted`, `payment captured`. Not: `becomes paid`.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["action"],
          spec: "An Action transitioning between States names the event or command, not the destination state.",
        },
      },
      {
        // P3
        policy:
          "State `invariants` are observable predicates a reader can check — `order.payment.captured = false`, not `the order is happy`.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["state"],
          spec: "Check ONLY the State's `invariants` array. If `invariants` is empty, missing, or absent from the entity, this rule PASSES (vacuously true). When invariants are present, each entry must read as an observable predicate a reader can check programmatically (e.g., `order.payment.captured = false`), not a subjective quality (e.g., `the order is happy`). Do NOT judge the State's `state` field — only the invariants array matters here.",
        },
      },
      {
        // P4
        policy:
          "The state-machines doco's purpose Intent names the entity being modeled (e.g., `order`, `worker job`, `agent session`) so readers can read the machine.",
        fires_when_neuron_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["intent"],
          spec: "The Doco's purpose Intent names the entity being modeled.",
        },
      },
      {
        // P5 — fires only on Actions that look like compensating /
        // cancellation paths. Happy-path transitions pass.
        policy:
          "Compensating or cancellation transitions reference a Decision explaining why the path exists — they're the exceptional flow and need their reasoning recorded. Happy-path transitions are exempt.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["action"],
          spec: "STEP 1 — decide whether this Action represents a compensating, cancellation, rollback, refund, undo, abort, abandon, or otherwise-undoing transition between States. Look at the Action's `verb` and `action` for words like 'cancel', 'refund', 'rollback', 'undo', 'revert', 'abort', 'abandon', 'compensate', 'reverse'. If the Action is a normal happy-path transition (e.g., 'checkout submitted', 'payment captured', 'order shipped'), this rule PASSES — return ok. STEP 2 — only if the Action IS a compensating/cancellation transition, check that `decision_ids` is non-empty. If empty, FAIL with a reason explaining the Action looks like a compensating path but doesn't cite a Decision.",
        },
      },
      {
        // P-regions
        policy:
          "If a machine has multiple active States of kind `initial`, the Doco's purpose Intent explains why — parallel regions, optional entry points, etc. — so readers don't assume it's a wiring mistake.",
        fires_when_neuron_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["intent"],
          spec: "When the Doco has multiple active initial States, the purpose Intent explains parallel regions or optional entry points.",
        },
      },
      {
        // P-orphan-transition
        policy:
          "A transition Action with empty `triggered_by` AND empty `gated_by` is either an explicit immediate transition (the `action` field explains why it fires unconditionally) or an authoring oversight — capture the intent.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["action"],
          spec: "A transition Action with empty triggered_by AND empty gated_by either explicitly justifies its unconditional firing in the `action` field, or is an authoring oversight to flag.",
        },
      },
      // ── Descriptive (documentation-only) ──
      {
        // D11 (descriptive, not enforced)
        policy:
          "Reachability isn't enforced at the framework level. The completeness rules above catch missing wiring on activate (orphan intermediates) — strict reachability (every State reachable from an initial) is a manual review.",
        kind: "guidance",
      },
      {
        // D12 (descriptive)
        policy:
          "Hierarchical / composite / parallel States are deliberately not modeled in v1. A machine that needs them models the sub-machine as a separate Doco or a clearly linked Intent.",
        kind: "guidance",
      },
    ],
  },
  {
    // Executable tests inspired by TDD and AI evals. Each Eval pins one
    // checkable claim about a Decision, Policy, Action, or other
    // load-bearing neuron; the template seeds the policies that govern
    // how those Evals are authored. Opt-in (not auto-installed) —
    // projects that want test add it explicitly.
    name: "test",
    label: "Tests",
    icon: "🧪",
    description:
      "Executable tests and AI evals pin load-bearing claims in the doco. Each Eval names one checkable property, declares a criterion, and points at the entity it tests.",
    defaultNeuronLifecycle: "drafting",
    policies: [
      // ── Deterministic structural gates ──
      {
        // D1 — content-type gate. Evals belong here; policies
        // seeded by this template live alongside them.
        policy:
          "Only Eval neurons and policies (guidance_policy, neuron_authoring_policy) belong to test. Domain content lives in its own Doco.",
        predicate: {
          kind: "requires_entity_type",
          entity_types: ["eval", "guidance_policy", "neuron_authoring_policy"],
        },
      },
      {
        // D2
        policy:
          "Every Eval declares what it is and how it's graded — `eval` and `criterion` are required from creation.",
        predicate: {
          kind: "requires_field",
          fields: ["eval", "criterion"],
          when_neuron_type: ["eval"],
        },
      },
      {
        // D3
        policy:
          "Every Eval declares its `kind` (unit, integration, eval, process, doc-consistency). Choosing one frames how reviewers read the criterion and how the runner produces `actual`.",
        predicate: {
          kind: "requires_field",
          fields: ["kind"],
          when_neuron_type: ["eval"],
        },
      },
      {
        // D4 — only fires on activate so drafts can be sketched without a target.
        policy:
          "An active Eval points at the claim it tests via `target_ref`. Drafted Evals can be captured without a target while the test is being shaped.",
        predicate: {
          kind: "requires_field",
          fields: ["target_ref"],
          when_neuron_type: ["eval"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        // D5 — only fires on activate; drafts can be incomplete.
        policy:
          "An active Eval ships its reproduction steps in `how_to_run` — the exact command, prompt, URL, or manual procedure. Without it the test can't be re-run.",
        predicate: {
          kind: "requires_field",
          fields: ["how_to_run"],
          when_neuron_type: ["eval"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      // ── Probabilistic style gates ──
      {
        // P1
        policy:
          "Eval `eval` reads as a checkable property of the system (e.g. `user-email-validation accepts .+@.+ form`), not a serial label (`test 1`, `eval A`, `it works`).",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["eval"],
          spec: "Check ONLY the Eval's `eval` field. It must read as a checkable property of the system — a phrase describing what should be true (e.g. `user-email-validation accepts .+@.+ form`, `merge button disabled until reviewers approve`). It must NOT be a serial or meaningless label (`test 1`, `eval A`, `it works`, `tbd`).",
        },
      },
      {
        // P2
        policy:
          "An Eval tests one property. If `eval` or `criterion.spec` joins multiple independent claims with 'and', it's a split candidate.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["eval"],
          spec: "Check the Eval's `eval` field and `criterion.spec`. The Eval should test ONE checkable property. If either field describes multiple independent properties joined by 'and' (e.g. 'the form validates emails AND rejects empty submissions AND shows a toast'), it's a split candidate — FAIL with a reason naming the split.",
        },
      },
      {
        // P3
        policy:
          "`exact` and `shape` criteria need a concrete top-level Eval `expected` value, not prose. `llm-judge` criteria put the prose property into `criterion.spec` (or top-level `expected` when more natural) and read crisply enough that two reviewers would reach the same verdict.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["eval"],
          spec: "Inspect the Eval's `criterion.kind` and top-level `expected` field. If criterion.kind is `exact` or `shape`, the Eval's top-level `expected` MUST be a concrete value or shape (number, string, object, array) — prose like 'the user is signed in' FAILS. Do not require `expected` inside the `criterion` object; the API shape stores it beside `criterion`. If criterion.kind is `llm-judge`, the prose property lives in `criterion.spec` (or top-level `expected` when more natural) and reads crisply enough that two reviewers would reach the same verdict. Vague or subjective specs (`the output is good`) FAIL.",
        },
      },
      {
        // P4 — only fires once the Eval is meant to be runnable.
        policy:
          "An active Eval's `how_to_run` is reproducible without hidden context: it names the command, prompt, URL, or manual procedure plus any required fixture or environment.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["eval"],
          spec: "Check the Eval's `how_to_run` field. PASS when it gives a concrete rerun path: an exact command, prompt, URL, or manual procedure, plus any required fixture, input, account, environment, or setup needed to produce `actual`. FAIL when it is vague (`run the tests`, `ask the agent`, `manual QA`) or depends on unstated context.",
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        // P5
        policy:
          "An Eval has a recognizable test oracle: the `criterion` / top-level `expected` pair says what evidence is observed, what it is compared against, and what counts as pass/fail.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["eval"],
          spec: "Inspect the Eval's `criterion` and top-level `expected` field. PASS when the oracle is recognizable: it names the actual evidence to observe, the expected value or property to compare against, and the pass/fail boundary. For `exact` and `shape`, a concrete top-level `expected` value can carry the oracle if it is clear what `actual` is compared to. For `llm-judge`, `criterion.spec` must name the evidence and the decision boundary. FAIL vague or circular criteria like `works`, `matches requirements`, `is good`, or restatements of the Eval label without observable evidence.",
        },
      },
      // ── Guidance ──
      {
        kind: "guidance",
        policy:
          'TDD-style evals are first-class. Write the eval before the feature lands with `expected_status: "fail"` and `lifecycle: "drafting"`. The first time it reports `last_status: "pass"`, flip `expected_status` to `"pass"` and move to `active` — it\'s now a regression guard.',
      },
      {
        kind: "guidance",
        policy:
          "A regression eval (one written to lock in a bug fix) stays in the doco forever. Removing it requires a Decision linking back to the eval that explains why the guard is no longer needed.",
      },
      {
        kind: "guidance",
        policy:
          "Treat this as a test-pyramid rule: prefer the smallest effective check. Use a unit or integration Eval when deterministic behavior answers the question; reserve process, doc-consistency, and `llm-judge` Evals for behavior that cannot be recognized by a smaller structural or executable test.",
      },
      {
        kind: "guidance",
        policy:
          "Given/When/Then or Arrange/Act/Assert phrasing is welcome when it clarifies setup, action, and expectation, but keep one behavior per Eval.",
      },
      {
        kind: "guidance",
        policy:
          'To track per-run history (e.g. for flakiness), capture a Log per run with `Log.target` pointing at the Eval, `verb` set to `"passed"` or `"failed"`, and `happened_at` set to the run time. The Eval\'s `last_*` fields are a snapshot of the most recent Log.',
      },
      {
        kind: "guidance",
        policy:
          "A flaky Eval is not green. Record every outcome as a Log, stabilize the runner/data/environment before relying on it, or retire the Eval with a Decision that explains why the signal is no longer useful.",
      },
      {
        kind: "guidance",
        policy:
          'A `last_status: "pass"` from long ago is effectively unknown — re-run before citing it. Project owners pick the freshness threshold; the framework doesn\'t impose one.',
      },
      {
        kind: "guidance",
        policy:
          'Process and doc-consistency evals are graded by `criterion.kind: "llm-judge"` whose spec describes the procedure or claim to check (e.g. `the agent reads connections.md before posting captures`). The runner produces `actual` from the trace or a human transcript and submits it for judging.',
      },
      {
        kind: "guidance",
        policy:
          "When a repo-native automated test exists or can reasonably exist, the Eval's `how_to_run` points at that command or file. The Doco Eval is the durable claim and audit trail, not a replacement for executable test code.",
      },
      {
        kind: "guidance",
        policy:
          "Large fixtures, golden files, screenshots, and transcripts live as References or repo artifacts. Keep Eval `input`, `expected`, and `actual` small enough to review inline.",
      },
      {
        kind: "guidance",
        policy:
          "`exact` and `shape` are preferred for deterministic checks; reserve `llm-judge` for semantic behavior, process traces, and documentation consistency where a structural comparison would hide the real question.",
      },
      {
        kind: "guidance",
        policy:
          "Use `target_ref` to pin the Eval to the specific entity whose meaning it locks in: a Decision when it tests a choice, a neuron_authoring_policy or guidance_policy when it tests a policy claim, an Action when it tests designed behavior.",
      },
      {
        kind: "guidance",
        policy:
          "An Eval tests entities in its own doco via `target_ref`. Tests that span multiple docos wait for the imports machinery — the framework doesn't yet resolve cross-doco refs (refs.ts:14-15).",
      },
    ],
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
    defaultNeuronLifecycle: "drafting",
    perspectives: [{ slug: "list", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        on_violation: "warn",
        policy:
          "A node belongs in glossaries when it defines product or domain terminology, records a terminology choice, cites an authoritative source, states a terminology usage rule, or checks terminology consistency. Feature work, process flows, org charts, and runtime events belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in glossaries when it defines product or domain terminology, records a terminology choice, cites an authoritative source, states a terminology usage rule, or checks terminology consistency. PASS for term entries, glossary scope, terminology usage rules, references to source glossaries/specs/docs, and evals that scan terminology consistency. FAIL for feature implementation work, process flows, org charts, runtime incidents, or state-machine stages.",
          when_neuron_type: ["intent", "decision", "rule", "reference", "eval"],
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
            "neuron_authoring_policy",
          ],
        },
      },

      // ── Term entry Decisions ───────────────────────────────────
      {
        policy:
          "Every active glossary Decision declares `question`, `chosen`, and `decided_by`: the concept question, canonical term, and principal who owns the terminology choice.",
        predicate: {
          kind: "requires_field",
          fields: ["question", "chosen", "decided_by"],
          when_neuron_type: ["decision"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        policy:
          "Active glossary Decisions must have a unique canonical term in `chosen`, compared case-insensitively.",
        predicate: {
          kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_neuron_type: ["decision"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        policy:
          "A glossary Decision defines one concept. Split entries that define multiple independent terms or concepts.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["decision"],
          spec: "Read the Decision's `question`, `chosen`, and `decision` prose. PASS when the entry defines one concept or one canonical term. FAIL with a reason when it defines multiple independent terms, bundles a term with an unrelated policy, or uses one entry as a catch-all for several concepts.",
        },
      },
      {
        policy:
          "An active glossary Decision's `decision` prose includes a concise definition, product/domain scope, and at least one example or non-example.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["decision"],
          spec: "Read the Decision's `decision` prose. PASS when it includes (1) a concise definition, (2) the product or domain scope where the term applies, and (3) at least one concrete example or non-example. FAIL with which element is missing when the prose is too vague for a reader to use the term consistently.",
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        policy:
          "Acronyms and abbreviations in glossary entries spell out the expanded form and state when the short form is acceptable.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["decision"],
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
          when_neuron_type: ["eval"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },
      {
        policy:
          "An active glossary Eval's `how_to_run` names a concrete command, query, URL, or review procedure plus any scope needed to reproduce the terminology check.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["eval"],
          spec: "Check the Eval's `how_to_run` field. PASS when it gives a concrete rerun path: an exact command, search query, URL, script, or manual review procedure, plus the doc/code/product scope to inspect. FAIL when it is vague (`review docs`, `check terminology`) or depends on unstated context.",
        },
        fires_when_neuron_lifecycle: ["active"],
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
    // gateways. Sequence flow is explicit and forward-only via
    // `sequence_to`, which materializes as `sequence_flow`; generic Doco
    // dependency / rationale synapses remain associations and are not
    // treated as BPMN arrows.
    name: "business-processes",
    label: "business-processes",
    icon: "🏭",
    description:
      "Document repeatable business processes — the flow of work through actors, gateways, and milestones to a business outcome. Inspired by BPMN swimlanes and gateways.",
    defaultNeuronLifecycle: "drafting",
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
        // when_neuron_type. Personal / informal workflows pass too:
        // the gate cares about "workflow with steps, actors, outcome",
        // not "this is paid work at a company".
        on_violation: "warn",
        policy:
          "A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. One-off incidents, UI-specific user journeys, and pure state machines without a workflow outcome belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in business-processes when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. Pass when the candidate describes a step, gateway, milestone, validation, reference, or policy for such a workflow. Fail only when the candidate is a one-off incident with no repeatable structure, a UI-specific user journey, or a pure state machine without a workflow outcome.",
          when_neuron_type: ["intent", "action", "decision", "state", "eval", "reference"],
        },
      },
      {
        // Deterministic node-type allowlist. Logs (recorded executions)
        // live in a sibling Doco and are surfaced here via Reference;
        // Ideas live in their own home until promoted.
        policy:
          "Only Intent, Action, Decision, State, Eval, Reference, Rule, and Principal belong here. Logs (recorded executions) live in a sibling Doco and are referenced from here; Ideas live in their own home until promoted.",
        predicate: {
          kind: "requires_neuron_type",
          neuron_types: [
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
          when_neuron_type: ["principal"],
        },
      },

      // ── Intent shape ────────────────────────────────────────────
      {
        policy:
          "Every Intent in business-processes must declare `actors` — the principals expected to act in this process.",
        predicate: {
          kind: "requires_field",
          fields: ["actors"],
          when_neuron_type: ["intent"],
        },
      },
      {
        // Stakeholders without an Action of their own surface via a
        // Reference, an Eval, or a Rule that cites them via `gated_by`.
        policy:
          "Every Intent in business-processes must declare `stakeholders` — the principals with a say in the outcome even if they don't act directly. Stakeholders without an Action surface via Reference, Eval, or a `gated_by` Rule.",
        predicate: {
          kind: "requires_field",
          fields: ["stakeholders"],
          when_neuron_type: ["intent"],
        },
      },
      {
        // Probabilistic on intent — the trigger, terminal business
        // outcome, and out-of-scope boundary must all be discernible
        // from the Intent's `intent` field.
        policy:
          "The purpose Intent of a business process names the trigger that starts the process, the terminal business outcome that ends it, and what is explicitly out of scope. Readers should be able to discern all three from the Intent's `intent` field.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Intent's `intent` field. The purpose Intent of a business process must name (1) the trigger that starts the process, (2) the terminal business outcome that ends it, and (3) what is explicitly out of scope. PASS if all three are discernible; FAIL with which is missing if one or more is absent.",
          when_neuron_type: ["intent"],
        },
      },

      // ── Action shape & handoffs ─────────────────────────────────
      {
        policy:
          "Every Action in business-processes must declare the principal who performs the activity in the `actor_id` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_neuron_type: ["action"],
        },
      },
      {
        // Team-roles (`kitchen`, `support`, `finance`) are first-class
        // Principals representing a role rather than an individual.
        // (Post-rename, person/agent distinction moved to Collaborator;
        // the engine just enforces principal resolution.)
        policy:
          "An Action's `actor_id` must resolve to an existing Principal. Team-roles (e.g. `kitchen`, `support`, `finance`) are first-class Principals — model them as Principals representing a role rather than an individual.",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_neuron_type: ["action"],
        },
      },
      {
        policy:
          "Every Action in business-processes must `serves` an Intent. Without it the process renderer can't tie the step to the business outcome it advances.",
        predicate: {
          kind: "requires_synapse",
          synapse_type: "serves",
          target_neuron_type: "intent",
          when_neuron_type: ["action"],
        },
      },
      {
        policy:
          "Every Action in business-processes must declare its `inputs` — the artifacts it consumes from upstream.",
        predicate: {
          kind: "requires_field",
          fields: ["inputs"],
          when_neuron_type: ["action"],
        },
      },
      {
        // Producer outputs line up with consumer inputs — the explicit
        // handoff guidance below depends on these being filled in.
        policy:
          "Every Action in business-processes must declare its `outputs` — the artifacts it hands to downstream Actions. A producer's outputs should line up with the next consumer's inputs.",
        predicate: {
          kind: "requires_field",
          fields: ["outputs"],
          when_neuron_type: ["action"],
        },
      },
      {
        // Atomic activity prose — reject umbrella phases and
        // implementation chores divorced from business meaning.
        policy:
          "Action `action` reads as an atomic business activity — a single unit of work an actor performs. Reject vague umbrella phases (`handle request`, `do the thing`) and reject implementation chores divorced from business meaning (`call API`, `update row`).",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Action's `action` and `verb`. PASS when the text names an atomic business activity — a single unit of work the named actor performs. FAIL with reason if the text is a vague umbrella phase (e.g. `handle request`, `do the thing`, `process order`) or an implementation chore divorced from business meaning (e.g. `call API`, `update row`, `write to DB`).",
          when_neuron_type: ["action"],
        },
      },
      {
        // Inputs/outputs are designed business artifacts (records,
        // approvals, signed contracts) — not concrete runtime values.
        // Both empty is fine; mandatory presence is handled by the
        // requires_field rules above.
        policy:
          "Inputs and outputs are business artifacts (a purchase order, a signed contract, an approved invoice), not concrete runtime values (HTTP 200, row count = 4, a JWT). If both `inputs` and `outputs` are empty the rule above already speaks; otherwise reject concrete policies.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — if both `inputs` and `outputs` are empty or missing, this rule PASSES (the requires_field rules above handle missing values). STEP 2 — otherwise inspect each value present in `inputs` and `outputs`. PASS when entries name business artifacts (a purchase order, a signed contract, an approved invoice, an SLA bound). FAIL with reason if any entry is a concrete runtime policy (HTTP 200, row count = 4, a JWT, a SQL row, a bytes-on-the-wire format).",
          when_neuron_type: ["action"],
        },
      },
      {
        policy:
          "Side-effecting Actions (Actions with a physical-world or financial consequence — money moved, goods shipped, a contract signed) should have an explicit compensation or exception path in `sequence_to`, usually guarded by a Decision or a `gated_by` Rule.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — decide whether this Action has a physical-world or financial side effect (money moved, goods shipped, a contract signed, an email sent to a counterparty). Look at the `verb`, `action`, and `outputs` for words like `ship`, `pay`, `charge`, `sign`, `send`, `dispatch`, `disburse`, `commit`. If the Action has no such side effect, this rule PASSES. STEP 2 — only if the Action IS side-effecting, check that the modeled process names a compensation or exception path: preferably a `sequence_to` branch to a compensating Action / Decision, or a `gated_by` Rule that authorizes reversal. FAIL with reason if neither shape is visible.",
          when_neuron_type: ["action"],
        },
      },
      {
        // Exception/cancellation Actions — the path itself is exceptional
        // and the rationale needs to be recorded.
        policy:
          "Exception, cancellation, refund, reject, and escalate Actions should be reached by explicit `sequence_to` flow from the gateway or activity that opens that path, and should cite any authorizing Rule through `gated_by`.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — decide whether this Action is a cancellation, refund, reject, escalate, abort, or otherwise-exceptional path. Look at the `verb` and `action` for words like `cancel`, `refund`, `reject`, `escalate`, `abort`, `void`, `dispute`, `deny`. If the Action is a normal happy-path activity, this rule PASSES. STEP 2 — only if the Action IS an exception/cancellation path, check that the flow can be reached through explicit `sequence_to` from an upstream gateway/activity, or that `gated_by` cites a Rule authorizing it. FAIL with reason if the path appears orphaned.",
          when_neuron_type: ["action"],
        },
      },
      {
        // Sub-process invocation — delegate via Intent reference, not
        // by inlining steps from the sub-process here.
        policy:
          "An Action that delegates to another process should cite the sub-process by its Intent (via `intent_ids`) or via a Reference in its `action` field — never inline the sub-process's steps here.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — decide whether this Action delegates to another business process (a sub-process invocation). Look for phrases like `run X process`, `kick off X`, `invoke the X workflow`, `escalate to the X process`. If the Action does not delegate, this rule PASSES. STEP 2 — only if it does delegate, check that EITHER `intent_ids` references the sub-process's purpose Intent OR the `action` field cites a Reference pointing at the sub-process. FAIL with reason if the sub-process's steps appear inlined in the `action` field instead.",
          when_neuron_type: ["action"],
        },
      },
      {
        policy:
          "Actions whose verb or action implies retry or iteration must show how the loop terminates — usually through a forward `sequence_to` edge to a Decision with an exit branch, plus any `gated_by` Rule that bounds iteration.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — decide whether this Action's `verb` or `action` implies a retry or loop (words like `retry`, `poll`, `keep checking`, `until`, `each time`, `recur`). If not, this rule PASSES. STEP 2 — only if the Action loops, check that the outgoing `sequence_to` flow reaches a Decision or State that names the exit/give-up condition, or that `gated_by` includes a Rule that bounds the iteration. FAIL with reason if neither shape is present.",
          when_neuron_type: ["action"],
        },
      },
      {
        // Timer-driven Actions name an anchor and an ISO 8601 offset
        // so a reader can compute when the Action fires.
        policy:
          "Scheduled or timer-driven Actions must name both an anchor (a State's `entered_at`, an absolute timestamp, or a prior Action's completion) AND an ISO 8601 offset (`PT24H`, `P3D`, `PT15M`) in the `action` field. `nightly` and `every so often` are not anchors.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — decide whether this Action is scheduled or timer-driven (words like `after`, `every`, `nightly`, `daily`, `wait`, `on the Xth`, `following N days`). If not, this rule PASSES. STEP 2 — only if it is, check that the `action` names BOTH (a) a concrete anchor — a named State's `entered_at`, an absolute timestamp, or a prior Action's completion — and (b) an ISO 8601 duration offset (e.g. `PT24H`, `P3D`, `PT15M`). FAIL with reason if either is missing.",
          when_neuron_type: ["action"],
        },
      },
      {
        // Trust boundaries — org / tenant / external-system crossings
        // are load-bearing; the crossing has to be called out so
        // downstream auth / compliance / SLA discussions can happen.
        policy:
          "Actions whose counterparty is across an organizational, tenant, or external-system boundary must call out the crossing in the `action` field. Internal-only Actions are exempt.",
        predicate: {
          kind: "probabilistic",
          spec: "STEP 1 — decide whether the Action crosses a trust boundary: the counterparty is in a different organization, a different tenant, an external vendor, a regulator, or any system outside the actor's own administrative domain. If everything stays inside one boundary, this rule PASSES. STEP 2 — only if there is a crossing, check that the `action` explicitly names the boundary being crossed (e.g. `sent to the customer`, `posted to Stripe`, `submitted to HMRC`). FAIL with reason if the crossing is implicit.",
          when_neuron_type: ["action"],
        },
      },
      {
        // Consistent level of abstraction — reject Actions that mix
        // operator-level granularity ("Onboard customer") with
        // implementation granularity ("Verify VAT checksum") inside one
        // process model.
        policy:
          "Actions in one business process sit at a consistent level of abstraction. Reject models that mix operator-level Actions (`Onboard customer`) with implementation Actions (`Verify VAT checksum`) — split the lower-level steps into a sub-process.",
        predicate: {
          kind: "probabilistic",
          spec: "Compare this Action's grain to the other Actions in the same business-processes Doco. PASS when the Action sits at a similar level of abstraction to its siblings. FAIL with reason if the Action is markedly more granular (a small implementation step amid operator-level steps) or markedly broader (a phase among atomic steps). The fix is usually to split the lower-level steps into a sub-process.",
          when_neuron_type: ["action"],
        },
      },

      // ── Decision shape ──────────────────────────────────────────
      {
        policy:
          "Every Decision in business-processes must `serves` an Intent — gateways belong to a concrete process/pool and need that link to be explicit.",
        predicate: {
          kind: "requires_synapse",
          synapse_type: "serves",
          target_neuron_type: "intent",
          when_neuron_type: ["decision"],
        },
      },
      {
        policy:
          "Every State in business-processes must `serves` an Intent — milestones and events belong to a concrete process/pool and need that link to be explicit.",
        predicate: {
          kind: "requires_synapse",
          synapse_type: "serves",
          target_neuron_type: "intent",
          when_neuron_type: ["state"],
        },
      },
      {
        // Exhaustive branches: question reads as yes/no or enumerated,
        // and the alternatives list either has a default/else branch
        // or covers every enum value.
        policy:
          "Gateway Decisions in business-processes have exhaustive outgoing branches. The `question` reads as yes/no or an enumerated choice, and the `alternatives` plus `sequence_to` branch labels either include a default/else branch or name every enum value.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Decision's `question`, `alternatives`, and any `sequence_to` branch labels/conditions. PASS when the question reads as yes/no or an enumeration, AND the alternatives / outgoing branches either include an explicit default/else branch or name every enumerated value. FAIL with reason if the question has uncovered cases or if a default/else is missing where enum coverage isn't visibly complete.",
          when_neuron_type: ["decision"],
        },
      },
      {
        // Mutually exclusive branches by default; inclusive gateways
        // must opt in explicitly so silent overlap is caught.
        policy:
          "Decision branches are mutually exclusive by default. Inclusive or parallel gateways must be explicit in the `question`, `decision`, or outgoing `sequence_to` metadata — otherwise overlapping conditions count as a wiring mistake.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Decision's `alternatives` and outgoing `sequence_to` branch labels/conditions. PASS when the branches are visibly mutually exclusive OR the `question`, `decision`, or sequence metadata explicitly marks the gateway as inclusive/parallel (e.g. `select all that apply`, `inclusive gateway`, `parallel gateway`). FAIL with reason if conditions on multiple branches could plausibly be true at once and inclusivity isn't declared.",
          when_neuron_type: ["decision"],
        },
      },
      {
        // >4 branches is a smell — usually the wrong shape; nesting or
        // a classifier Action upstream usually reads better.
        policy:
          "A Decision with more than four branches is a smell. Consider nesting Decisions or moving the classification into an upstream Action that emits an explicit category.",
        predicate: {
          kind: "probabilistic",
          spec: "Count the entries in `alternatives`. PASS if four or fewer. WARN (still fail) with reason if there are five or more — usually the right fix is to nest Decisions or to move the classification into an upstream classifier Action that emits a category into the gateway.",
          when_neuron_type: ["decision"],
        },
      },

      // ── State shape & sequence wiring ───────────────────────────
      {
        policy:
          "State `state` is unique within a business process — duplicate milestone names ambiguate references and hide wiring mistakes.",
        kind: "guidance",
      },
      {
        policy:
          "An active business process has ≥1 active State of kind `initial` — every process starts somewhere.",
        kind: "guidance",
      },
      {
        policy:
          "An active business process has ≥1 active State of kind `terminal` — every process has a business outcome (or an explicitly cancelled outcome).",
        kind: "guidance",
      },
      {
        policy: "Terminal States have no outgoing `sequence_to` flow — they end the process path.",
        kind: "guidance",
      },
      {
        policy:
          "Each active initial State has at least one outgoing `sequence_to` target — otherwise the process starts but never moves.",
        kind: "guidance",
      },
      {
        policy:
          "Every `sequence_to` target should be a flow node in the same process Intent. Use branch labels or conditions on `sequence_to` objects for gateway edges.",
        kind: "guidance",
      },
      {
        policy:
          "Every non-initial flow node should be reachable from an earlier flow node through forward `sequence_to`; every non-terminal flow node should have at least one outgoing `sequence_to` target.",
        kind: "guidance",
      },
      {
        // State summary as milestone/condition (parallels state-machines
        // P1) — noun or past-participle naming the milestone.
        policy:
          "State `state` reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`), not an imperative verb naming an Action (`Approve invoice`).",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["state"],
          spec: "Check ONLY the State's `state`. PASS when the text reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`, `awaiting-review`). FAIL with reason if it reads as an imperative verb naming an Action (`Approve invoice`, `Process the order`).",
        },
      },
      {
        // Milestone vs steady-state — the reader should be able to tell
        // from summary/kind/invariants whether the State is transient
        // (a milestone the process passes through) or steady (a
        // condition the process holds for a span of time).
        policy:
          "The reader can tell from a State's `state`, `kind`, and `invariants` together whether it is a transient milestone (the process passes through it) or a steady condition (the process holds it for a span of time).",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["state"],
          spec: "Read the State's `state`, `kind`, and `invariants` together. PASS when a reader can tell whether the State is a transient milestone the process passes through, or a steady condition the process holds for some span of time. FAIL with reason if the three together are ambiguous.",
        },
      },
      {
        // Observable invariants — parallels state-machines P3. Vacuously
        // true if invariants is empty.
        policy:
          "State `invariants` read as observable predicates a reader can check (`invoice.status = approved`, `actor has signed`), not subjective qualities (`the request feels right`). Empty invariants are vacuously fine.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["state"],
          spec: "Check ONLY the State's `invariants` array. If `invariants` is empty, missing, or absent, this rule PASSES (vacuously true). When invariants are present, each entry must read as an observable predicate a reader can check (`invoice.status = approved`, `signature_count >= 2`). FAIL with reason if any entry is a subjective quality (`the request feels right`, `the customer is happy`).",
        },
      },
      {
        // Parallel convergence — when a State is the join point of ≥2
        // parallel branches, the join predicate must be named so the
        // reader knows whether it's AND-join, OR-join, or another shape.
        policy:
          "When a State is the convergence of two or more parallel branches, its `state` names the join predicate (AND-join, OR-join, first-completes, threshold) so the reader knows what triggers entry.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["state"],
          spec: "STEP 1 — decide whether this State is a convergence of two or more parallel branches (incoming Actions from concurrent branches). If not, this rule PASSES. STEP 2 — only if it IS a convergence, check that the `state` names the join predicate (AND-join — wait for all; OR-join — first to arrive; threshold — N of M; etc.). FAIL with reason if the join semantics are not stated.",
        },
      },

      // ── Coverage ────────────────────────────────────────────────
      {
        // Each principal listed on an Intent's `actors` must be the
        // actor_id of ≥1 Action serving the Intent. Fires only when
        // the Intent moves to `active` so drafting Intents can be
        // sketched first and have their Actions filled in later.
        policy:
          "Every principal listed in an Intent's `actors` must be the `actor_id` of at least one Action that `serves` the Intent. Fires when the Intent is active — drafting Intents are allowed to be incomplete.",
        predicate: {
          kind: "graph-completeness",
          list_field: "actors",
          synapse_type: "serves",
          incoming_neuron_type: "action",
          incoming_field_must_match: "actor_id",
          when_neuron_type: ["intent"],
        },
        fires_when_neuron_lifecycle: ["active"],
      },

      // ── Eval ────────────────────────────────────────────────────
      {
        policy:
          "Every Eval in business-processes must declare its `target_ref` — the node whose claim the Eval pins.",
        predicate: {
          kind: "requires_field",
          fields: ["target_ref"],
          when_neuron_type: ["eval"],
        },
      },
      {
        // Evals must pin a process-critical claim — completeness,
        // handoff, SLA, branch coverage, policy compliance — not a
        // vague "this should work".
        policy:
          "Evals in business-processes pin a process-critical claim — a completeness check, a handoff invariant, an SLA bound, a branch coverage, or a policy compliance — not a vague `this should work`.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Eval's `eval`, `criterion`, and `expected`. PASS when the Eval pins a process-critical claim: a completeness check (all required Actions exist), a handoff invariant (producer's output matches consumer's input), an SLA bound (process completes within X), a branch coverage (every Decision branch is exercised), or a policy compliance (a Rule's predicate holds). FAIL with reason if the claim is vague (`it should work`, `looks good`).",
          when_neuron_type: ["eval"],
        },
      },

      // ── Reference ───────────────────────────────────────────────
      {
        // References in business-processes must be authoritative
        // (policy doc, regulatory citation, vendor spec, or sibling
        // Doco with recorded runs). Decorative links are rejected.
        policy:
          "References in business-processes are authoritative — a policy document, a regulatory citation, a vendor specification, or a sibling Doco that records process *instances*. Decorative links (a marketing blog post, an unrelated tweet) belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Reference's `ref_type`, `locator`, and `reference`. PASS when the Reference points at an authoritative source: a policy document, a regulatory citation, a vendor specification, an API contract, or a sibling Doco that records process *instances* (Logs of runs). FAIL with reason if the Reference is decorative or unrelated (a marketing blog post, an unrelated tweet, a generic explainer).",
          when_neuron_type: ["reference"],
        },
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        kind: "guidance",
        policy:
          "Model a repeatable business process that produces a business outcome — not a UI journey, a code path, an incident, or a pure state machine. UI journeys belong in user-flows; pure state machines in state-machines.",
      },
      {
        kind: "guidance",
        policy:
          "Use one linked Intent per concrete process when the Doco is large. Split on a durable ownership boundary, reuse across multiple parents, or pure readability.",
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
          "Author the happy path first, then exceptions / compensation / rollback / cancellation / escalation paths — they read most clearly when the normal flow is already in place.",
      },
      {
        kind: "guidance",
        policy:
          "Sub-processes are themselves process Intents — reference them by their Intent, not by inlining their steps into the parent process.",
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
          "Make handoffs explicit: a producer Action's `outputs` should line up with the next consumer Action's `inputs`. Implicit shared state hides where work is actually exchanged.",
      },
      {
        kind: "guidance",
        policy:
          "Don't model every click, method call, or DB mutation — only the steps that mean something to a business operator. Implementation detail belongs in `apis` or code Docos, not here.",
      },
    ],
  },
  {
    // Organizational chart template. Principals are the org members,
    // `reports_to` synapses form the hierarchy, Intents represent
    // teams/units, Decisions record reorgs and appointments. After
    // the Principal slim-down (decision_01KSDR_PRINCIPAL_SLIM_DOWN)
    // a Principal carries only `name` + `body_md`; the person-vs-agent
    // distinction lives in the body_md prose, enforced by a
    // probabilistic policy rather than a `requires_field` check.
    name: "org-chart",
    label: "org-chart",
    icon: "🏢",
    description:
      "Map the people and AI agents in an organization — reporting lines, teams, roles, and appointments. Every member declares whether they're a person or an AI agent in their `body_md` prose.",
    defaultNeuronLifecycle: "drafting",
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
        // what they do.
        policy:
          "Only Principal, Intent, Decision, Reference, and Rule belong in an org chart. Actions describe activities (use business-processes or user-flows); States describe stages (use state-machines); Logs describe events; Ideas live in their own home.",
        predicate: {
          kind: "requires_neuron_type",
          neuron_types: ["principal", "intent", "decision", "reference", "rule"],
        },
      },

      // ── The unique bit — every member declares person or AI agent ──
      {
        // THE DISTINGUISHING CONSTRAINT. The Principal slim-down moved
        // person-vs-agent out of a structured field and into the
        // body_md prose. Org charts still need the declaration, so
        // this probabilistic policy reads body_md and blocks captures
        // that leave the distinction ambiguous.
        policy:
          "Every Principal in an org chart must declare whether it's a person or an AI agent in its `body_md` prose. The org-tree perspective infers the distinction from the prose; without an explicit declaration a chart can't tell humans from AI agents.",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["principal"],
          spec: "Read the Principal's `body_md`. PASS if the prose clearly states the role is filled by a human person (e.g. 'Human director of …', 'Person responsible for …') OR by an AI agent (e.g. 'AI agent operated by @alice', 'Autonomous research bot'). FAIL with a reason if `body_md` is empty or doesn't take a stance on person-vs-agent.",
        },
      },

      // ── Hierarchy: every Principal either reports up or explains root ──
      {
        // `reports_to` is a Principal→Principal synapse that forms the
        // org tree. This uses a single probabilistic warning rather
        // than a deterministic `requires_synapse` predicate because a
        // valid root Principal (CEO/founder/root agent/external
        // authority) should not receive an unavoidable "missing
        // reports_to" warning once its body_md explains the absence.
        on_violation: "warn",
        policy:
          "Every active Principal in an org chart either declares `reports_to` (the Principal they report to) or explains in `body_md` why it is top-of-chain (founder, board-reporting, root agent, external authority).",
        predicate: {
          kind: "probabilistic",
          when_neuron_type: ["principal"],
          spec: "Read the Principal candidate. PASS if `reports_to` is a non-empty Principal id. Otherwise, PASS only if `body_md` explains why this Principal has no manager above it (founder, board-reporting, root agent, external authority, etc.). FAIL with reason when an active Principal has no `reports_to` and `body_md` does not explain the missing reporting edge.",
        },
        fires_when_neuron_lifecycle: ["active"],
      },

      // ── Team Intents declare members ───────────────────────────
      {
        // Team / org-unit Intents (engineering, kitchen, support, etc.)
        // declare their member Principals in `actors`. This mirrors
        // the user-flows / business-processes convention. Stakeholders
        // (people interested in the unit's outcomes without being on
        // the team) optionally go in `stakeholders`.
        policy:
          "Every Intent in an org chart must declare `actors` — the Principals who are members of this team or unit.",
        predicate: {
          kind: "requires_field",
          fields: ["actors"],
          when_neuron_type: ["intent"],
        },
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        kind: "guidance",
        policy:
          "An org chart describes who reports to whom and which teams exist — not what those people do. Activities, processes, and workflows belong in business-processes or user-flows Docos linked via Reference.",
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
          "Person vs agent isn't about who signed in — it's about who fills the seat. A Principal whose `body_md` describes an AI agent (a code reviewer, a triage bot, a research agent) is an agent regardless of whether any Collaborator has signed in as it. A Principal whose `body_md` describes a human is a person, even if that human has no Doco account.",
      },
      {
        kind: "guidance",
        policy:
          "When an AI-agent role is replaced by a human (or vice-versa), retire the old Principal and create a new one with `body_md` describing the new occupant. Person-vs-agent is part of the role's identity in this Doco — flipping it via a body_md edit on the same Principal erases the history of the seat's prior occupant.",
      },
    ],
  },
];

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored under plain handles (`global`, `important`,
 * `user-flows`, `state-machines`, `test`, `glossaries`,
 * `business-processes`, `org-chart`).
 */
export function findDocoTemplateByName(name: string): DocoTemplate | undefined {
  return DEFAULT_DOCO_TEMPLATES.find((t) => t.name === name);
}
