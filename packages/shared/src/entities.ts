/**
 * TypeScript types for Doco entities. The source of truth for entity
 * shape — there is no parallel JSON Schema. Runtime validation in
 * @doco/core checks load + cross-reference resolution only.
 */

import type { EntityId, NodeType } from "./branded.js";

export type Lifecycle =
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
  summary: string;
  created_at: string; // ISO 8601 UTC
  created_by: EntityId<"principal">;
  updated_at?: string;
  updated_by?: EntityId<"principal">;
  lifecycle?: Lifecycle;
  scopes?: EntityId<"scope">[];
  born_from?: EntityId;
  /** Ordering / dependency. This entity comes after the listed ones. Lint forbids cycles. ADR-077. */
  follows?: EntityId[];
}

/** A scope selector predicate — see SCHEMA.md §5. Free-form for v0.1. */
export type ScopeSelector = Record<string, unknown>;

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

export interface Principal extends CommonFields {
  node_type: "principal";
  type: "person" | "agent"; // (kept per ADR-054; not renamed to is_agent)
  username: string;
  display_name: string;
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
  scopes?: EntityId<"scope">[];
  members?: DocoMember[];
  imports?: DocoImport[];
}

// ─── Intent ───────────────────────────────────────────────────────────────

export interface Intent extends CommonFields {
  node_type: "intent";
  title: string;
  parent_intent_id?: EntityId<"intent"> | null;
  priority?: "p0" | "p1" | "p2" | "p3";
  stakeholders?: EntityId<"principal">[];
  applies_to?: ScopeSelector;
}

// ─── Idea ─────────────────────────────────────────────────────────────────
// Speculative thought before it crystallizes into an Intent / Decision /
// Action. Per ADR-074. Lightweight on purpose.

export interface Idea extends CommonFields {
  node_type: "idea";
  proposer_id?: EntityId<"principal">;
  body?: string;
  promoted_to?: EntityId; // Intent / Decision / Action when picked up
  rejection_reason?: string;
}

// ─── Rule ─────────────────────────────────────────────────────────────────

/**
 * Discriminator on Rule entities (decision_01KRPRDR1AD7S1RP6E69BQDB2G):
 *
 *  - "tagged" (default when unset) — a regular Rule that happens to be
 *    tagged with a scope. No automated check; appears under "Tagged
 *    rules" on a scope's page.
 *  - "authoring" — engine-readable predicate fired at capture time.
 *    Carries `predicate` in the Rule's frontmatter; lifecycle=abandoned
 *    soft-disables it.
 *  - "guidance" — prose-only directive the agent reads while working in
 *    or with the scope. No predicate; the Rule's `summary` and
 *    optional `body_md` carry the text.
 */
export type RuleKind = "authoring" | "guidance" | "tagged";

/**
 * Authoring predicate — the structured shape the engine evaluates at
 * write time. Used as `Rule.predicate` when `Rule.kind === "authoring"`.
 * The old `predicate: string` field on Rule (pre-promotion) was removed.
 *
 * Per decision_01KRRD5SRX69P2MWN0G1B8216H, `requires_edge`, `forbids_edge`,
 * `requires_field`, and `forbids_field` carry an optional
 * `when_node_type: NodeType[]` filter. When set, the evaluator
 * short-circuits and produces no violation if the candidate entity's
 * `node_type` is not in the list. When omitted, behavior is unchanged
 * (the rule fires for every node the scope's authoring-rule set is
 * loaded against). `mandatory_scope` and `requires_node_type` don't
 * need the filter — the first is Doco-wide by construction, the second
 * already targets node types directly. `probabilistic` defers to the
 * LLM judge.
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
  | { kind: "mandatory_scope"; scope_ids: EntityId<"scope">[] }
  | { kind: "requires_node_type"; node_types: NodeType[] }
  | { kind: "probabilistic"; spec: string };

export interface Rule extends CommonFields {
  node_type: "rule";
  /**
   * Rule role per decision_01KRPRDR1AD7S1RP6E69BQDB2G. Defaults to
   * "tagged" when unset (the pre-promotion shape).
   */
  kind?: RuleKind;
  /** Authoring predicate (only when kind === "authoring"). */
  predicate?: AuthoringPredicate;
  modality?: "must" | "must_not" | "should" | "should_not";
  severity?: "blocker" | "warning" | "info";
  phase?: "declared" | "pre" | "post" | "invariant";
  applies_to?: ScopeSelector;
  expected?: unknown;
  on_violation?: "block" | "warn" | "log";
}

// ─── Decision ─────────────────────────────────────────────────────────────

export interface DecisionAlternative {
  name?: string;
  rejected_because?: string;
}

export interface Decision extends CommonFields {
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

export interface Action extends CommonFields {
  node_type: "action";
  /** Imperative or present-tense verb describing the step. Required. */
  verb: string;
  /** Who performs the step — typically a role-principal ("user", "system",
   *  "agent") created at project setup. Required. */
  actor_id: EntityId<"principal">;
  /** What is acted on (the target node — a Doco, scope, intent, etc.). */
  target?: EntityId;
  /** The umbrella Intent(s) the step advances. */
  intent_ids?: EntityId<"intent">[];
  /** Decisions that branch at this point (BPMN gateway analog). */
  decision_ids?: EntityId<"decision">[];
  /** Designed input shape — describes what flows in, not concrete values. */
  inputs?: Record<string, unknown>;
  /** Designed output shape — describes what flows out, not concrete values. */
  outputs?: Record<string, unknown>;
}

// ─── Log (recorded happening) ─────────────────────────────────────────────
// A specific event that occurred at a point in time, with concrete
// outputs. The runtime/instance counterpart to Action's design-level
// template. Use for commits, deploys, verifications, audit-trail entries.
//
// Logs are FROZEN FROM CREATION (mutability.server.ts treats them like
// References) — editorial fixes happen via supersession, not in-place
// edits, so the audit trail stays trustworthy.

export interface Log extends CommonFields {
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
// Run history is NOT captured in the Doco — that's CI/the runner's job.
// Each Eval carries only its LATEST status (`last_status`, `last_run_at`,
// `last_reason`); the runner updates those fields in place when it
// executes the Eval. The test definition itself (`criterion`, `input`,
// `expected`) is the editable, versioned document.
//
// Criterion kinds:
//   exact     — `actual === expected` (deep equal for objects).
//   shape     — `actual` matches `expected`'s shape (v0 keeps it loose).
//   llm-judge — `expected` describes the desired property in prose; an LLM
//               judges `actual` and returns pass/fail + reason.
//
// A `target_ref` points the Eval at the claim it tests (a Decision, Rule,
// Action, etc.). Derived edge: `tests` from Eval → target.
//
// Replaces both the original EVO placeholder name AND the abandoned
// Evaluation node type (which was tied to Rules + meant to capture per-run
// outcomes — never used, since run history lives outside the Doco).

export interface EvalCriterion {
  kind: "exact" | "shape" | "llm-judge";
  /** Free-form criterion spec. For exact/shape ignored; for llm-judge this is the prose property to check. */
  spec?: string;
}

export interface Eval extends CommonFields {
  node_type: "eval";
  /** Readable name. */
  name: string;
  /** What the eval tests, in prose. */
  description?: string;
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

export interface Reference extends CommonFields {
  node_type: "reference";
  ref_type: "file" | "url" | "ticket" | "commit" | "document" | "other";
  locator: string;
  content_hash?: string | null;
}

// ─── Scope ────────────────────────────────────────────────────────────────
// Topical neighborhood. Renamed from Tag (ADR-078). Edge-hierarchical: parent
// scopes live in `scopes: []` (the common field) — no slash-in-name. Per
// ADR-081. Scope-facing guidance lives in first-class Rule entities tagged
// with the scope, not embedded description/purpose/guidelines fields.

/**
 * Per-rule lifecycle (decision_01KRPNZY7W6CCMYNKGND67BP0B). Rules on a
 * scope follow the same lifecycle stages every other node uses — "active"
 * is the working default, "abandoned" is what the Abandon action sets, and the
 * engine + agent-facing surfaces only consider non-abandoned rules.
 */
export type RuleLifecycle = "active" | "proposed" | "abandoned" | "superseded";

export interface Scope extends CommonFields {
  node_type: "scope";
  /** Flat token: ^[a-z][a-z0-9_-]*$ */
  name: string;
  /**
   * Single emoji used to identify this scope at a glance. Surfaces on
   * the /scopes list, the entity-detail page, and as a prefix on every
   * capture footer-line that touches a node in this scope.
   * Default-templated scopes ship with a recommended icon; custom
   * scopes can pick any single emoji.
   */
  icon?: string;
  /**
   * "Watched" scopes are an attention signal for contributors (person or
   * agent) — when authoring a node, scan against watched scopes and tag
   * the new node into any that fit. Not enforced at capture time (that's
   * what `mandatory_scope` authoring rules on the Global scope are for,
   * when the project genuinely wants hard enforcement); a soft prompt to
   * think about the scope, captured in the scope-creation/edit flow so
   * the project's "topics worth tracking" stays visible.
   */
  watched?: boolean;
  // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G: scopes no longer carry
  // embedded `authoring_rules` or `guidance_rules`. Rules are first-class
  // Rule entities tagged with the scope (in_scope_of edge); the Rule's
  // `kind` field discriminates authoring / guidance / tagged.
}


// ─── Organization (ADR-062) ──────────────────────────────────────────────

export interface OrganizationMember {
  principal_id: EntityId<"principal">;
  role: "owner" | "admin" | "member" | "viewer";
  permissions?: ("read" | "write" | "execute" | "admin")[];
}

export interface Organization extends CommonFields {
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
  | Decision
  | Action
  | Log
  | Eval
  | Reference
  | Scope;

export type EntityByType<T extends Entity["node_type"]> = Extract<Entity, { node_type: T }>;
