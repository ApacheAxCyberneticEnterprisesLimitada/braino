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
 * Per-category discriminator fields (matches stored data jsonb):
 *   - Neurons   → `neuron_type: NeuronType`
 *   - Primitives → `primitive_kind: "guidance" | "neuron_authoring"`
 *   - Collaborator → `kind: "person" | "agent"`
 *   - Doco, Organization → no per-row discriminator
 *
 * `created_by` / `updated_by` reference collaborators (the OAuth
 * identity). `actor_id` / `actors[]` / `decided_by` continue to
 * reference principals (the role-personas).
 */

import type { EntityId, EntityType, NeuronType } from "./branded.js";

export type Lifecycle =
  | "drafted"
  | "proposed"
  | "active"
  | "retired";

export type Outcome = "succeeded" | "failed";

/**
 * Common fields present on every neuron + primitive entity (D-006,
 * D-007). The per-category discriminator (`neuron_type` /
 * `primitive_kind` / `kind`) lives on each concrete interface, not
 * here — different categories use different discriminator names.
 */
export interface CommonFields {
  id: EntityId;
  doco_id: EntityId<"doco">;
  created_at: string; // ISO 8601 UTC
  created_by: EntityId<"collaborator">;
  updated_at?: string;
  updated_by?: EntityId<"collaborator">;
  lifecycle?: Lifecycle;
  deprecated?: boolean;
  outcome?: Outcome;
  born_from?: EntityId;
  superseded_by?: EntityId | null;
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
  neuron_type: "principal";
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
  slug: string;
  display_name: string;
  visibility: "private" | "public";
  default_branch?: string;
  owner_id: OwnerRef;
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
  neuron_type: "intent";
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
  neuron_type: "idea";
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
  /**
   * Like `requires_neuron_type` but accepts any entity type, including
   * primitives. Used by the constitution template to allow Eval +
   * the two primitive kinds.
   */
  | { kind: "requires_entity_type"; entity_types: EntityType[] }
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
   * existing Principal (role-persona). Used to reject e.g. an Action
   * whose `actor_id` is a free-text string rather than a real
   * principal id.
   *
   * Post-rename: principals no longer carry a `type` field — the
   * person/agent split moved to Collaborator. The predicate no longer
   * constrains by `allowed_principal_types`; it just enforces that the
   * field resolves to an existing principal.
   */
  | {
      kind: "requires_field_resolves_to_principal";
      field: string;
      when_neuron_type?: NeuronType[];
    }
  | { kind: "descriptive"; spec: string; when_neuron_type?: NeuronType[] };

export interface Rule extends SummarizedFields {
  neuron_type: "rule";
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
  primitive_kind: "guidance";
}

export interface NeuronAuthoringPrimitive extends SummarizedFields {
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
  neuron_type: "decision";
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
  neuron_type: "action";
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
  neuron_type: "log";
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
  neuron_type: "eval";
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
  neuron_type: "reference";
  ref_type: "file" | "url" | "ticket" | "commit" | "document" | "other";
  locator: string;
  content_hash?: string | null;
}

// ─── State ────────────────────────────────────────────────────────────────

export type StateKind = "initial" | "intermediate" | "terminal";

export interface State extends SummarizedFields {
  neuron_type: "state";
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

/** Look up a Neuron interface by its `neuron_type` literal. */
export type NeuronByType<T extends Neuron["neuron_type"]> = Extract<Neuron, { neuron_type: T }>;

/** Look up a Primitive interface by its `primitive_kind` literal. */
export type PrimitiveByKind<T extends Primitive["primitive_kind"]> = Extract<
  Primitive,
  { primitive_kind: T }
>;
