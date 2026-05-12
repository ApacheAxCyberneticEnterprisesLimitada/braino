/**
 * TypeScript types for Doco entities.
 *
 * The canonical schema is `schema/doco.schema.json` at the Doco root —
 * these types mirror that schema for compile-time checking. Runtime validation
 * (against the JSON Schema) lives in @doco/core.
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
  schema_version: string;
  summary: string;
  created_at: string; // ISO 8601 UTC
  created_by: EntityId<"principal">;
  updated_at?: string;
  updated_by?: EntityId<"principal">;
  revision?: number;
  lifecycle?: Lifecycle;
  status?: string;
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
  type: "human" | "agent"; // (kept per ADR-054; not renamed to is_agent)
  username: string;
  display_name: string;
  github_identity?: GitHubIdentity;
  owner_id?: EntityId<"principal">;
  agent_metadata?: AgentMetadata;
  public_key?: string;
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
  schema_version: string;
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
  revision?: number;
  lifecycle?: Lifecycle;
  status?: string;
  scopes?: EntityId<"scope">[];
  members?: DocoMember[];
  imports?: DocoImport[];
}

// ─── Intent ───────────────────────────────────────────────────────────────

export interface Intent extends CommonFields {
  node_type: "intent";
  slug?: string;
  title: string;
  parent_intent_id?: EntityId<"intent"> | null;
  priority?: "p0" | "p1" | "p2" | "p3";
  non_goals?: string[];
  acceptance?: string[];
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
  slug?: string;
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
  slug?: string;
  number?: string;
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
  attestation?: string;
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

// ─── Evaluation (append-only) ─────────────────────────────────────────────

export interface Evaluation extends CommonFields {
  node_type: "evaluation";
  rule_id: EntityId<"rule">;
  target_id?: string;
  result: "pass" | "fail" | "error";
  evidence?: Record<string, unknown>;
  ran_at: string;
  ran_by: EntityId<"principal">;
  duration_ms?: number;
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

export interface Scope extends CommonFields {
  node_type: "scope";
  /** Flat token: ^[a-z][a-z0-9_-]*$ */
  name: string;
  description?: string;
  /** Why this scope exists; what nodes belong here. */
  purpose?: string;
  /** Markdown guidance on how to author nodes in this scope. */
  guidelines?: string;
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
  | Evaluation
  | Reference
  | Scope;

export type EntityByType<T extends Entity["node_type"]> = Extract<Entity, { node_type: T }>;
