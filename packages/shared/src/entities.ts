/**
 * TypeScript types for Doco entities. The source of truth for entity
 * shape — there is no parallel JSON Schema. Runtime validation checks
 * load + cross-reference resolution only.
 *
 * Post-rename vocabulary:
 *   - Neurons (10): graph-knowledge entities (intent, idea, rule,
 *     decision, action, log, eval, reference, state, principal)
 *   - Primitives (2): constitution metadata (guidance, neuron_authoring)
 *   - Collaborator (1): OAuth identity layer (separate from principal)
 *   - Doco, Organization: workspace + org containers
 *
 * The discriminator field on each entity interface is `entity_type`
 * (uniform across categories). `created_by` / `updated_by` reference
 * collaborators (the OAuth identity). `actor_id` / `actors[]` /
 * `decided_by` continue to reference principals (the role-personas).
 */

import type { EntityId, NeuronType } from "./branded.js";

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
  entity_type: string;
  created_at: string; // ISO 8601 UTC
  created_by: EntityId<"collaborator">;
  updated_at?: string;
  updated_by?: EntityId<"collaborator">;
  lifecycle?: Lifecycle;
  born_from?: EntityId;
  /** Ordering / dependency. This entity comes after the listed ones. */
  follows?: EntityId[];
}

/** Common fields for readable claim entities that carry a one-line summary. */
export interface SummarizedFields extends CommonFields {
  summary: string;
}

// ─── Collaborator (OAuth identity — new category) ─────────────────────────

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

/**
 * Collaborator — host-scoped OAuth identity. Person or agent runtime.
 * Authored neurons via `created_by` / `updated_by`. Member of orgs/docos
 * via `member_of` synapses.
 *
 * NOT on the graph as a neuron — collaborators are an identity layer.
 * Use `Principal` (the neuron) when documenting a role/persona that
 * participates in a flow.
 */
export interface Collaborator {
  id: EntityId<"collaborator">;
  entity_type: "collaborator";
  kind: "person" | "agent";
  github_id?: string;
  github_login: string;
  email?: string;
  avatar_url?: string;
  /** For agents: the person who spawned this agent. */
  owner_id?: EntityId<"collaborator">;
  agent_metadata?: AgentMetadata;
  created_at: string;
  deactivated_at?: string;
}

// ─── Principal (role-persona — neuron type) ───────────────────────────────

/**
 * Principal — documented role/persona that participates in flows.
 * Referenced by `Action.actor_id`, `Log.actor_id`, `Intent.actors[]`,
 * `Intent.stakeholders[]`. Slimmed from the pre-rename Principal which
 * also held OAuth identity; that concern is now `Collaborator`.
 */
export interface Principal extends SummarizedFields {
  entity_type: "principal";
  username: string; // role label: "system", "customer-service-rep", "user"
  display_name?: string;
  description?: string;
}

// ─── Doco (root entity) ───────────────────────────────────────────────────

export interface DocoMember {
  /** Membership is at the OAuth-identity layer; the field name reflects that. */
  collaborator_id: EntityId<"collaborator">;
  role: "owner" | "maintainer" | "contributor" | "viewer";
  permissions: ("read" | "write" | "execute" | "admin")[];
}

export interface DocoImport {
  doco: string;
  ref: string;
  as: string;
  include?: string[];
}

/** Doco.owner_id is polymorphic: Collaborator (user/agent) OR Organization. */
export type OwnerRef = EntityId<"collaborator"> | EntityId<"organization">;

export interface Doco {
  id: EntityId<"doco">;
  entity_type: "doco";
  slug: string;
  display_name: string;
  visibility: "private" | "public";
  default_branch?: string;
  owner_id: OwnerRef;
  description?: string;
  summary?: string;
  created_at?: string;
  created_by?: EntityId<"collaborator">;
  updated_at?: string;
  updated_by?: EntityId<"collaborator">;
  lifecycle?: Lifecycle;
  members?: DocoMember[];
  imports?: DocoImport[];
}

// ─── Intent ───────────────────────────────────────────────────────────────

export interface Intent extends SummarizedFields {
  entity_type: "intent";
  title: string;
  parent_intent_id?: EntityId<"intent"> | null;
  priority?: "p0" | "p1" | "p2" | "p3";
  stakeholders?: EntityId<"principal">[];
  /**
   * Principals expected to act in this flow. Each id should also be
   * the `actor_id` of at least one Action serving this Intent.
   */
  actors?: EntityId<"principal">[];
}

// ─── Idea ─────────────────────────────────────────────────────────────────

export interface Idea extends SummarizedFields {
  entity_type: "idea";
  /** Who proposed it. Collaborator (the OAuth identity), not a principal. */
  proposer_id?: EntityId<"collaborator">;
  body?: string;
  promoted_to?: EntityId; // Intent / Decision / Action when picked up
  rejection_reason?: string;
}

// ─── Rule ─────────────────────────────────────────────────────────────────

export type RuleKind = "guidance" | "tagged";

/**
 * Authoring predicate — the structured shape the engine evaluates at
 * write time. Stored as `Rule.predicate`.
 *
 * `when_neuron_type` (was `when_node_type`) filters the predicate to
 * candidates of specific neuron types. Note: predicates that target
 * primitives use a different filter; see plan §6.
 */
export type AuthoringPredicate =
  | {
      kind: "requires_synapse";
      synapse_type: string;
      target_neuron_type?: string;
      when_neuron_type?: NeuronType[];
    }
  | {
      kind: "forbids_synapse";
      synapse_type: string;
      target_neuron_type?: string;
      when_neuron_type?: NeuronType[];
    }
  | { kind: "requires_field"; fields: string[]; when_neuron_type?: NeuronType[] }
  | { kind: "forbids_field"; fields: string[]; when_neuron_type?: NeuronType[] }
  | { kind: "requires_neuron_type"; neuron_types: NeuronType[] }
  | { kind: "probabilistic"; spec: string; when_neuron_type?: NeuronType[] }
  | {
      kind: "graph-completeness";
      list_field: string;
      synapse_type: string;
      incoming_neuron_type: NeuronType;
      incoming_field_must_match: string;
      when_neuron_type?: NeuronType[];
    }
  /**
   * Field-resolution check: `entity[field]` must be the id of an
   * existing Principal (role-persona), and that Principal's category
   * must match. Used to reject e.g. an Action whose `actor_id` is a
   * free-text string rather than a real principal id.
   */
  | {
      kind: "requires_field_resolves_to_principal";
      field: string;
      when_neuron_type?: NeuronType[];
    }
  | { kind: "descriptive"; spec: string; when_neuron_type?: NeuronType[] };

export interface Rule extends SummarizedFields {
  entity_type: "rule";
  kind?: RuleKind;
  predicate?: AuthoringPredicate;
  fires_when_neuron_lifecycle?: Lifecycle[];
  modality?: "must" | "must_not" | "should" | "should_not";
  severity?: "blocker" | "warning" | "info";
  phase?: "declared" | "pre" | "post" | "invariant";
  expected?: unknown;
  on_violation?: "block" | "warn" | "log";
}

// ─── Primitives (constitution metadata) ───────────────────────────────────

export interface GuidancePrimitive extends SummarizedFields {
  entity_type: "guidance_primitive";
  primitive_kind: "guidance";
}

export interface NeuronAuthoringPrimitive extends SummarizedFields {
  entity_type: "neuron_authoring_primitive";
  primitive_kind: "neuron_authoring";
  evaluation_kind: "deterministic" | "probabilistic";
  predicate: AuthoringPredicate;
  fires_when_neuron_lifecycle?: Lifecycle[];
  on_violation?: "block" | "warn" | "log";
}

// ─── Decision ─────────────────────────────────────────────────────────────

export interface DecisionAlternative {
  name?: string;
  rejected_because?: string;
}

export interface Decision extends SummarizedFields {
  entity_type: "decision";
  intent_ids?: EntityId<"intent">[];
  question: string;
  chosen: string | null; // null when lifecycle is "proposed"
  alternatives?: DecisionAlternative[];
  rules_consulted?: EntityId<"rule">[];
  /** Who decided. The collaborator (OAuth identity) who made the call. */
  decided_by: EntityId<"collaborator">;
  decided_at: string;
  superseded_by?: EntityId<"decision"> | null;
}

// ─── Action (designed step) ───────────────────────────────────────────────

export interface Action extends SummarizedFields {
  entity_type: "action";
  verb: string;
  /** Who performs the step — a role-principal. */
  actor_id: EntityId<"principal">;
  target?: EntityId;
  intent_ids?: EntityId<"intent">[];
  decision_ids?: EntityId<"decision">[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  triggered_by?: EntityId<"action">[];
  gated_by?: EntityId<"rule">[];
}

// ─── Log (recorded happening) ─────────────────────────────────────────────

export interface Log extends SummarizedFields {
  entity_type: "log";
  verb: string;
  /** The principal (role) who performed it. */
  actor_id: EntityId<"principal">;
  happened_at: string;
  target?: EntityId;
  intent_ids?: EntityId<"intent">[];
  decision_ids?: EntityId<"decision">[];
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  template_id?: EntityId<"action">;
}

// ─── Eval (test/eval) ─────────────────────────────────────────────────────

export interface EvalCriterion {
  kind: "exact" | "shape" | "llm-judge";
  spec?: string;
}

export type EvalKind = "unit" | "integration" | "eval" | "process" | "doc-consistency";

export interface Eval extends SummarizedFields {
  entity_type: "eval";
  name: string;
  kind?: EvalKind;
  description?: string;
  expected_status?: "pass" | "fail";
  how_to_run?: string;
  input?: unknown;
  expected?: unknown;
  actual?: unknown;
  criterion: EvalCriterion;
  target_ref?: EntityId;
  last_run_at?: string;
  last_status?: "pass" | "fail" | "pending";
  last_reason?: string;
}

// ─── Reference ────────────────────────────────────────────────────────────

export interface Reference extends SummarizedFields {
  entity_type: "reference";
  ref_type: "file" | "url" | "ticket" | "commit" | "document" | "other";
  locator: string;
  content_hash?: string | null;
}

// ─── State ────────────────────────────────────────────────────────────────

export type StateKind = "initial" | "intermediate" | "terminal";

export interface State extends SummarizedFields {
  entity_type: "state";
  kind: StateKind;
  invariants?: string[];
}

// ─── Organization ─────────────────────────────────────────────────────────

export interface OrganizationMember {
  collaborator_id: EntityId<"collaborator">;
  role: "owner" | "admin" | "member" | "viewer";
  permissions?: ("read" | "write" | "execute" | "admin")[];
}

export interface Organization extends SummarizedFields {
  entity_type: "organization";
  slug: string;
  display_name: string;
  description?: string;
  visibility?: "private" | "public";
  members?: OrganizationMember[];
}

// ─── Discriminated unions ─────────────────────────────────────────────────

/** The 10 neuron types. */
export type Neuron =
  | Principal
  | Intent
  | Idea
  | Rule
  | Decision
  | Action
  | Log
  | Eval
  | Reference
  | State;

/** The 2 primitive types. */
export type Primitive = GuidancePrimitive | NeuronAuthoringPrimitive;

/** Every entity across all categories. */
export type Entity = Neuron | Primitive | Collaborator | Doco | Organization;

export type EntityByType<T extends Entity["entity_type"]> = Extract<Entity, { entity_type: T }>;
