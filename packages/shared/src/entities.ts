/**
 * TypeScript types for Doco entities. The source of truth for entity
 * shape — there is no parallel JSON Schema. Runtime validation in
 * @doco/core checks load + cross-reference resolution only.
 */

import type { EntityId, NodeType } from "./branded.js";

export type Lifecycle =
  | "drafted"
  | "proposed"
  | "active"
  | "succeeded"
  | "failed"
  | "superseded"
  | "abandoned";

/** Common fields present on every entity (D-006, D-007). */
export interface CommonFields {
  id: EntityId;
  doco_id: EntityId<"doco">;
  node_type: string;
  created_at: string; // ISO 8601 UTC
  created_by: EntityId<"principal">;
  updated_at?: string;
  updated_by?: EntityId<"principal">;
  lifecycle?: Lifecycle;
  born_from?: EntityId;
  /** Ordering / dependency. This entity comes after the listed ones. Don't create cycles. ADR-077. */
  follows?: EntityId[];
}

/** Common fields for readable claim nodes that carry a one-line summary. */
export interface SummarizedFields extends CommonFields {
  summary: string;
}

// ─── Principal ───────────────────────────────────────────────────────────

export interface GitHubIdentity {
  github_id?: string;
  github_login: string;
  email?: string;
}

export interface AgentMetadata {
  provider: string;
  model: string;
  capabilities?: string[];
  created_at: string;
}

export interface Principal extends SummarizedFields {
  node_type: "principal";
  type: "person" | "agent"; // (kept per ADR-054; not renamed to is_agent)
  username: string;
  github_identity?: GitHubIdentity;
  owner_id?: EntityId<"principal">;
  agent_metadata?: AgentMetadata;
}

// ─── Doco (root entity) ─────────────────────────────────────────────────

export interface DocoMember {
  principal_id: EntityId<"principal">;
  role: "owner" | "maintainer" | "contributor" | "viewer";
  permissions: ("read" | "write" | "execute" | "admin")[];
}

export interface DocoImport {
  doco: string;
  ref: string;
  as: string;
  include?: string[];
}

/** Doco.owner_id is polymorphic per ADR-063: Principal (user/agent) OR Organization. */
export type OwnerRef = EntityId<"principal"> | EntityId<"organization">;

export interface Doco {
  id: EntityId<"doco">;
  node_type: "doco";
  slug: string;
  display_name: string;
  visibility: "private" | "public";
  default_branch?: string;
  owner_id: OwnerRef;
  description?: string;
  summary?: string;
  created_at?: string;
  created_by?: EntityId<"principal">;
  updated_at?: string;
  updated_by?: EntityId<"principal">;
  lifecycle?: Lifecycle;
  members?: DocoMember[];
  imports?: DocoImport[];
}

// ─── Intent ───────────────────────────────────────────────────────────────

export interface Intent extends SummarizedFields {
  node_type: "intent";
  title: string;
  parent_intent_id?: EntityId<"intent"> | null;
  priority?: "p0" | "p1" | "p2" | "p3";
  stakeholders?: EntityId<"principal">[];
  /**
   * Principals expected to act in this flow. Each id should also be
   * the `actor_id` of at least one Action serving this Intent —
   * enforced by the `graph-completeness` rule in the user-flows
   * template.
   */
  actors?: EntityId<"principal">[];
}

// ─── Idea ─────────────────────────────────────────────────────────────────
// Speculative thought before it crystallizes into an Intent / Decision /
// Action. Per ADR-074. Lightweight on purpose.

export interface Idea extends SummarizedFields {
  node_type: "idea";
  proposer_id?: EntityId<"principal">;
  body?: string;
  promoted_to?: EntityId; // Intent / Decision / Action when picked up
  rejection_reason?: string;
}

// ─── Rule ─────────────────────────────────────────────────────────────────

/**
 * Discriminator on Rule entities. Two values:
 *
 *  - "tagged" (default when unset) — a Rule that has a `predicate` and/or
 *    appears under "Tagged rules".
 *  - "guidance" — prose-only directive (no `predicate`) the agent reads
 *    while working with the rule.
 */
export type RuleKind = "guidance" | "tagged";

/**
 * Authoring predicate — the structured shape the engine evaluates at
 * write time. Stored as `Rule.predicate`.
 *
 * Per decision_01KRRD5SRX69P2MWN0G1B8216H, `requires_edge`, `forbids_edge`,
 * `requires_field`, and `forbids_field` carry an optional
 * `when_node_type: NodeType[]` filter. When set, the evaluator
 * short-circuits and produces no violation if the candidate entity's
 * `node_type` is not in the list.
 *
 * v16 (decision_01KS3DW9C2KN2X7Z80R18H1RAX): the scope-flavored
 * predicate kinds (`mandatory_scope`, `unique-within-scope`,
 * `count-within-scope`, `graph-constraint`) were removed together with
 * the scopes concept. The remaining variants are all node-level
 * structural checks the engine could evaluate without a scope grain.
 */
export type AuthoringPredicate =
  | {
      kind: "requires_edge";
      edge_type: string;
      target_node_type?: string;
      when_node_type?: NodeType[];
    }
  | {
      kind: "forbids_edge";
      edge_type: string;
      target_node_type?: string;
      when_node_type?: NodeType[];
    }
  | { kind: "requires_field"; fields: string[]; when_node_type?: NodeType[] }
  | { kind: "forbids_field"; fields: string[]; when_node_type?: NodeType[] }
  | { kind: "requires_node_type"; node_types: NodeType[] }
  | { kind: "probabilistic"; spec: string; when_node_type?: NodeType[] }
  /**
   * Completeness check: for each principal id listed in
   * `entity[list_field]`, there must be at least one node with
   * `node_type === incoming_node_type`, an edge
   * `(other) --edge_type--> (entity)`, and
   * `other[incoming_field_must_match] === <that principal id>`.
   *
   * Pairs naturally with `fires_when_node_lifecycle: ["active"]` so a
   * mid-construction Intent isn't rejected while its Actions are
   * still being authored.
   */
  | {
      kind: "graph-completeness";
      list_field: string;
      edge_type: string;
      incoming_node_type: NodeType;
      incoming_field_must_match: string;
      when_node_type?: NodeType[];
    }
  /**
   * Field-resolution check: `entity[field]` must be the id of an
   * existing Principal, and that Principal's `type` must be in
   * `allowed_principal_types`. Used to reject e.g. an Action whose
   * `actor_id` is a free-text string ("the system", "app.js") rather
   * than a real person|agent principal.
   */
  | {
      kind: "requires_field_resolves_to_principal";
      field: string;
      allowed_principal_types: ("person" | "agent")[];
      when_node_type?: NodeType[];
    }
  | { kind: "descriptive"; spec: string; when_node_type?: NodeType[] };

export interface Rule extends SummarizedFields {
  node_type: "rule";
  /**
   * Rule role. Defaults to "tagged" when unset.
   */
  kind?: RuleKind;
  /** Authoring predicate. Optional — a Rule may be guidance-only. */
  predicate?: AuthoringPredicate;
  /**
   * When set, this Rule only fires against candidates whose
   * `lifecycle` is in this list. Omitted → fires regardless of the
   * candidate's lifecycle.
   */
  fires_when_node_lifecycle?: Lifecycle[];
  modality?: "must" | "must_not" | "should" | "should_not";
  severity?: "blocker" | "warning" | "info";
  phase?: "declared" | "pre" | "post" | "invariant";
  expected?: unknown;
  on_violation?: "block" | "warn" | "log";
}

// ─── Constitution Articles ────────────────────────────────────────────────

export interface GuidanceArticle extends SummarizedFields {
  node_type: "guidance_article";
  article_type: "guidance";
}

export interface NodeAuthoringArticle extends SummarizedFields {
  node_type: "node_authoring_article";
  article_type: "node_authoring";
  evaluation_kind: "deterministic" | "probabilistic";
  predicate: AuthoringPredicate;
  fires_when_node_lifecycle?: Lifecycle[];
  on_violation?: "block" | "warn" | "log";
}

// ─── Decision ─────────────────────────────────────────────────────────────

export interface DecisionAlternative {
  name?: string;
  rejected_because?: string;
}

export interface Decision extends SummarizedFields {
  node_type: "decision";
  intent_ids?: EntityId<"intent">[];
  question: string;
  chosen: string | null; // null when lifecycle is "proposed"
  alternatives?: DecisionAlternative[];
  rules_consulted?: EntityId<"rule">[];
  decided_by: EntityId<"principal">;
  decided_at: string;
  superseded_by?: EntityId<"decision"> | null;
}

// ─── Action ───────────────────────────────────────────────────────────────
// An Action is a DESIGNED step in a process — the BPMN/UML/ADR primitive
// for "this is what happens at this point in the flow." Templates, not
// instances. The verb is imperative or present-tense ("user clicks Buy",
// "system validates payment"); `inputs`/`outputs` describe the expected
// shapes, not concrete values. Chain with `follows` to express order.
//
// For specific recorded happenings (a commit, a deploy, a verification
// that ran), use `Log` instead. Logs may optionally point back at the
// Action they instance via `Log.template_id`.

export interface Action extends SummarizedFields {
  node_type: "action";
  /** Imperative or present-tense verb describing the step. Required. */
  verb: string;
  /** Who performs the step — typically a role-principal ("user", "system",
   *  "agent") created at project setup. Required. */
  actor_id: EntityId<"principal">;
  /** What is acted on (the target node — a Doco, intent, etc.). */
  target?: EntityId;
  /** The umbrella Intent(s) the step advances. */
  intent_ids?: EntityId<"intent">[];
  /** Decisions that branch at this point (BPMN gateway analog). */
  decision_ids?: EntityId<"decision">[];
  /** Designed input shape — describes what flows in, not concrete values. */
  inputs?: Record<string, unknown>;
  /** Designed output shape — describes what flows out, not concrete values. */
  outputs?: Record<string, unknown>;
  /**
   * Other Actions whose firing triggers this Action. General "this Action
   * fires in response to those Actions"; not state-machine-specific. 0..N.
   * Empty + empty `gated_by` is a legitimate immediate/unconditional step.
   */
  triggered_by?: EntityId<"action">[];
  /**
   * Rules that gate this Action — transition guards, pre/post conditions,
   * etc.
   */
  gated_by?: EntityId<"rule">[];
}

// ─── Log (recorded happening) ─────────────────────────────────────────────
// A specific event that occurred at a point in time, with concrete
// outputs. The runtime/instance counterpart to Action's design-level
// template. Use for commits, deploys, verifications, audit-trail entries.
//
// Logs are FROZEN FROM CREATION (mutability.server.ts treats them like
// References) — editorial fixes happen via supersession, not in-place
// edits, so the audit trail stays trustworthy.

export interface Log extends SummarizedFields {
  node_type: "log";
  /** Past-tense verb describing what happened ("pushed", "deployed",
   *  "verified"). Required. */
  verb: string;
  /** The specific principal who performed it. Required. */
  actor_id: EntityId<"principal">;
  /** When it happened. ISO 8601 UTC. Required — this is what distinguishes
   *  a Log from an Action. */
  happened_at: string;
  /** What was acted on. */
  target?: EntityId;
  /** The Intent advanced by this Log. */
  intent_ids?: EntityId<"intent">[];
  /** Decisions enacted (e.g., a deploy Log enacts the deploy Decision). */
  decision_ids?: EntityId<"decision">[];
  /** Concrete input values (the actual data fed in). */
  inputs?: Record<string, unknown>;
  /** Concrete output values — commit hash, deploy URL, metric, file path.
   *  Required in spirit; the project owner's authoring rules typically
   *  enforce non-empty values. */
  outputs?: Record<string, unknown>;
  /** Optional pointer back to the Action this Log is an instance of —
   *  e.g., a commit Log instances the "agent pushes code" Action. */
  template_id?: EntityId<"action">;
}

// ─── Eval (test/eval node) ────────────────────────────────────────────────
// An Eval is a named, executable test/eval that pins the meaning of a
// load-bearing claim in the Doco. Inspired by TDD unit tests + AI evals.
//
// The test definition (`kind`, `criterion`, `input`, `expected`,
// `how_to_run`) is the editable, versioned document. The runner updates
// the snapshot fields (`last_status`, `last_run_at`, `last_reason`) in
// place after each run.
//
// Per-run history lives in Log nodes, not on the Eval itself. To track
// flakiness or build a run timeline, emit a Log per run with
// `Log.target` pointing at the Eval, `verb` set to `"passed"` /
// `"failed"`, `happened_at` set to the run time, and `outputs` carrying
// the trace or reason. The Eval's `last_*` fields are a snapshot of the
// most recent Log.
//
// Criterion kinds:
//   exact     — `actual === expected` (deep equal for objects).
//   shape     — `actual` matches `expected`'s shape (v0 keeps it loose).
//   llm-judge — `expected` describes the desired property in prose; an LLM
//               judges `actual` and returns pass/fail + reason.
//
// A `target_ref` points the Eval at the claim it tests (a Decision, Rule,
// Action, etc.). Derived edge: `tests` from Eval → target.

export interface EvalCriterion {
  kind: "exact" | "shape" | "llm-judge";
  /** Free-form criterion spec. For exact/shape ignored; for llm-judge this is the prose property to check. */
  spec?: string;
}

/**
 * What flavor of test an Eval is. Frames how reviewers read the criterion
 * and which authoring rules fire on it. The framework doesn't branch on
 * the value — it's editorial, surfaced in UI and citable by authoring
 * articles in the `#test` template.
 *
 *  - "unit"            — deterministic check on a piece of data/output.
 *  - "integration"     — deterministic check across components.
 *  - "eval"            — rubric / LLM-judged behavioral check.
 *  - "process"         — does the agent/human follow the procedure?
 *  - "doc-consistency" — does the codebase match what the Doco claims?
 */
export type EvalKind = "unit" | "integration" | "eval" | "process" | "doc-consistency";

export interface Eval extends SummarizedFields {
  node_type: "eval";
  /** Readable name. */
  name: string;
  /** What flavor of test this is. */
  kind?: EvalKind;
  /** What the eval tests, in prose. */
  description?: string;
  /**
   * The status the author expects the runner to report. Defaults to
   * `"pass"` when unset.
   *
   *  - `"pass"` — regression / steady-state check. A `last_status: "fail"`
   *    is a real red that needs attention.
   *  - `"fail"` — TDD-aspirational. The eval is authored before the
   *    feature lands; a matching `"fail"` outcome counts as green for
   *    dashboards (expected red). When the eval first reports `"pass"`,
   *    flip `expected_status` to `"pass"` and the eval becomes a
   *    regression guard.
   */
  expected_status?: "pass" | "fail";
  /**
   * Free-form reproduction steps that produce `actual` — the exact
   * command, prompt, URL, or manual procedure. Required in spirit for
   * non-trivial evals; the #test template's authoring articles enforce
   * non-empty values once the eval activates.
   */
  how_to_run?: string;
  /** The eval's input fixture (any shape). */
  input?: unknown;
  /** The expected outcome (any shape). For llm-judge this is a prose criterion. */
  expected?: unknown;
  /** The last-observed actual outcome. Updated by the runner. */
  actual?: unknown;
  criterion: EvalCriterion;
  /** The Doco entity this Eval tests (Decision, Rule, Action, …). */
  target_ref?: EntityId;
  /** ISO timestamp of the last run. Updated by the runner. */
  last_run_at?: string;
  /** Outcome of the last run. Updated by the runner. */
  last_status?: "pass" | "fail" | "pending";
  /** If last_status === "fail", a one-line reason. Updated by the runner. */
  last_reason?: string;
}

// ─── Reference ────────────────────────────────────────────────────────────

export interface Reference extends SummarizedFields {
  node_type: "reference";
  ref_type: "file" | "url" | "ticket" | "commit" | "document" | "other";
  locator: string;
  content_hash?: string | null;
}

// ─── State (state-machine node) ───────────────────────────────────────────
// A State is a node in a formal state machine: a position the modeled
// entity occupies for some span of time. Distinct from Action (which
// happens in an instant). State semantics: holds invariants while
// occupied; reached via Actions whose `follows` includes this State.

export type StateKind = "initial" | "intermediate" | "terminal";

export interface State extends SummarizedFields {
  node_type: "state";
  /** Required. One of initial / intermediate / terminal. */
  kind: StateKind;
  /**
   * Predicates true while the modeled entity occupies this State.
   * Free-form prose — the framework doesn't parse these.
   */
  invariants?: string[];
}

// ─── Organization (ADR-062) ──────────────────────────────────────────────

export interface OrganizationMember {
  principal_id: EntityId<"principal">;
  role: "owner" | "admin" | "member" | "viewer";
  permissions?: ("read" | "write" | "execute" | "admin")[];
}

export interface Organization extends SummarizedFields {
  node_type: "organization";
  slug: string;
  display_name: string;
  description?: string;
  visibility?: "private" | "public";
  members?: OrganizationMember[];
}

// ─── Discriminated union of all entities ──────────────────────────────────

export type Entity =
  | Principal
  | Doco
  | Organization
  | Intent
  | Idea
  | Rule
  | GuidanceArticle
  | NodeAuthoringArticle
  | Decision
  | Action
  | Log
  | Eval
  | Reference
  | State;

export type EntityByType<T extends Entity["node_type"]> = Extract<Entity, { node_type: T }>;
