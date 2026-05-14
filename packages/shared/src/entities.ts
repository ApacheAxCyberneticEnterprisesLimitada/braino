/**
 * TypeScript types for Doco entities. The source of truth for entity
 * shape — there is no parallel JSON Schema. Runtime validation in
 * @doco/core checks load + cross-reference resolution only.
 */

import type { EntityId } from "./branded.js";

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

export interface Rule extends CommonFields {
  node_type: "rule";
  modality: "must" | "must_not" | "should" | "should_not";
  severity?: "blocker" | "warning" | "info";
  phase: "declared" | "pre" | "post" | "invariant";
  applies_to: ScopeSelector;
  predicate?: string;
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

export interface Action extends CommonFields {
  node_type: "action";
  actor_id: EntityId<"principal">;
  verb: string;
  target?: EntityId;
  intent_ids?: EntityId<"intent">[];
  decision_ids?: EntityId<"decision">[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  started_at?: string;
  ended_at?: string;
}

// ─── Reasoning ────────────────────────────────────────────────────────────

export interface ReasoningPremise {
  node_type: string;
  ref: EntityId;
  as: string;
}

export interface Reasoning extends CommonFields {
  node_type: "reasoning";
  author_id: EntityId<"principal">;
  premises: ReasoningPremise[];
  inference: string;
  conclusion_ref?: EntityId;
  confidence?: number;
  uncertainty?: string[];
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
// Replaces both the original EVO placeholder name AND the deprecated
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
// ADR-081. Self-explaining: `purpose` says why this scope exists, `guidelines`
// says how nodes inside it should be authored. Per ADR-082.

/**
 * A rule attached to a Scope. Evaluated by the rules engine on every
 * capture / scope-add. Deterministic rules are evaluated against the
 * entity's frontmatter + the Doco's graph; probabilistic rules ask the
 * LLM to interpret a prose spec and return accept/reject.
 *
 * (Distinct from the Rule *node type* in the Doco's graph — these are
 * the predicates a Scope itself enforces on its members.)
 */
export type ScopeRule =
  | { kind: "requires_edge"; edge_type: string; target_node_type?: string; reason?: string }
  | { kind: "forbids_edge"; edge_type: string; target_node_type?: string; reason?: string }
  /**
   * Frontmatter fields that nodes in this scope MUST declare. Plural because
   * one rule typically expresses a whole set of required fields ("nodes here
   * must declare summary, intent_ids, and lifecycle"), not a single one. The
   * engine still emits one violation per missing field so authors see
   * exactly what to add. Loader accepts the legacy `field: string` shape
   * and normalizes to `fields: [field]`.
   */
  | { kind: "requires_field"; fields: string[]; reason?: string }
  | { kind: "forbids_field"; fields: string[]; reason?: string }
  /**
   * Doco-wide mandatory scopes — every node must list each of these. Plural
   * for the same reason as the field rules. Loader accepts the legacy
   * `scope_id: string` shape and normalizes to `scope_ids: [scope_id]`.
   */
  | { kind: "mandatory_scope"; scope_ids: EntityId<"scope">[]; reason?: string }
  /** Probabilistic — LLM reads the spec + the candidate node, returns ok/reason. */
  | { kind: "probabilistic"; spec: string };

export interface Scope extends CommonFields {
  node_type: "scope";
  /** Flat token: ^[a-z][a-z0-9_-]*$ */
  name: string;
  /**
   * Single emoji used to identify this scope at a glance. Surfaces on
   * the /scopes list, the /constitution tab, the entity-detail page,
   * and as a prefix on every capture footer-line that touches a node
   * in this scope. Default-templated scopes ship with a recommended
   * icon; custom scopes can pick any single emoji.
   */
  icon?: string;
  description?: string;
  /** Why this scope exists; what nodes belong here. */
  purpose?: string;
  /** Markdown guidance on how to author nodes in this scope. */
  guidelines?: string;
  /**
   * Rules — predicates evaluated when a node enters this scope (on
   * capture, or on a scope-add via update). Failures from deterministic
   * kinds block the write; probabilistic kinds surface as warnings.
   */
  rules?: ScopeRule[];
  /**
   * "Watched" scopes are an attention signal for contributors (person or
   * agent) — when authoring a node, scan against watched scopes and tag
   * the new node into any that fit. Not enforced at capture time (that's
   * what `mandatory_scope` rules on the Constitution are for, when the
   * project genuinely wants hard enforcement); a soft prompt to think
   * about the scope, captured in the scope-creation/edit flow so the
   * project's "topics worth tracking" stays visible.
   */
  watched?: boolean;
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
  | Reasoning
  | Eval
  | Reference
  | Scope;

export type EntityByType<T extends Entity["node_type"]> = Extract<Entity, { node_type: T }>;
