/**
 * TypeScript types for Doco entities. The source of truth for entity
 * shape — there is no parallel JSON Schema. Runtime validation checks
 * load + cross-reference resolution only.
 *
 * Post-rename vocabulary:
 *   - Nodes (10): graph-knowledge entities (intent, idea, rule,
 *     decision, action, log, eval, reference, state, principal)
 *   - Policies (2): Doco-level authoring metadata (guidance, node_authoring)
 *   - User (1): OAuth identity layer (separate from principal)
 *   - Doco, Organization: workspace + org containers
 *
 * Per-category discriminator fields (matches stored data jsonb):
 *   - Nodes   → `node_type: NodeType`
 *   - Policies → `policy_kind: "guidance" | "node_authoring"`
 *   - User → `kind: "person" | "agent"`
 *   - Doco, Organization → no per-row discriminator
 *
 * `created_by` / `updated_by` reference users (the OAuth
 * identity). `actor_id` / `actors[]` / `decided_by` continue to
 * reference principals (the role-personas).
 */

import type { EntityId, EntityType, NodeType } from "./branded.js";

export type Lifecycle = "drafting" | "asserted" | "retired";

export type Outcome = "succeeded" | "failed";

export interface SequenceFlowTarget {
  target: EntityId;
  label?: string;
  condition?: string;
  kind?: "default" | "conditional" | "exception" | "timer";
}

/**
 * Common fields present on every node + policy entity (D-006,
 * D-007). The per-category discriminator (`node_type` /
 * `policy_kind` / `kind`) lives on each concrete interface, not
 * here — different categories use different discriminator names.
 */
export interface CommonFields {
  id: EntityId;
  doco_id: EntityId<"doco">;
  created_at: string; // ISO 8601 UTC
  created_by: EntityId<"user">;
  updated_at?: string;
  updated_by?: EntityId<"user">;
  lifecycle?: Lifecycle;
  deprecated?: boolean;
  outcome?: Outcome;
  born_from?: EntityId;
  superseded_by?: EntityId | null;
  /**
   * Legacy ordering / dependency. Each listed entity precedes this one.
   * BPMN processes should use `sequence_to` for forward sequence flow.
   */
  preceded_by?: EntityId[];
  /**
   * BPMN-native forward sequence flow. Each listed target happens after
   * this entity; object entries can carry branch labels / conditions.
   */
  sequence_to?: (EntityId | SequenceFlowTarget)[];
}

/** Common fields for readable claim entities that carry a one-line summary. */
export interface SummarizedFields extends CommonFields {
  summary: string;
}

/**
 * Migration-022: each node type gains a type-named prose field
 * (`intent` on intents, `rule` on rules, etc.). During the additive
 * window the field is optional and parallel to `summary` + `body_md`;
 * once the rename completes it becomes the single required prose
 * carrier and `summary` / `body_md` / `title` / `name` / `description`
 * are dropped.
 */

// ─── User (OAuth identity — new category) ─────────────────────────

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
 * User — host-scoped OAuth identity. Person or agent runtime.
 * Authored nodes via `created_by` / `updated_by`. Member of orgs/docos
 * via `member_of` edges.
 *
 * NOT on the graph as a node — users are an identity layer.
 * Use `Principal` (the node) when documenting a role/persona that
 * participates in a flow.
 */
export interface User {
  id: EntityId<"user">;
  kind: "person" | "agent";
  github_id?: string;
  github_login: string;
  email?: string;
  avatar_url?: string;
  /** For agents: the person who spawned this agent. */
  owner_id?: EntityId<"user">;
  agent_metadata?: AgentMetadata;
  created_at: string;
  deactivated_at?: string;
}

// ─── Principal (role-persona — node type) ───────────────────────────────

/**
 * Principal — documented role/persona that participates in flows.
 * Referenced by `Action.actor_id`, `Log.actor_id`, `Intent.actors[]`,
 * `Intent.stakeholders[]`. Slimmed from the pre-rename Principal which
 * also held OAuth identity; that concern is now `User`.
 */
// Principal carries `name` (display label) + `body_md` (everything
// else); the `summary` one-liner was dropped by migration 037 because
// it duplicated body_md prose without adding signal. Extends
// CommonFields rather than SummarizedFields for that reason — same
// pattern the 9 migrated node types (Intent, Decision, …) use.
export interface Principal extends CommonFields {
  node_type: "principal";
  /** Markdown body — the canonical narrative for the Principal. */
  body_md?: string;
  /** Display label for the Principal. Other nodes reference Principals
   *  by id; duplicate names are allowed. */
  name: string;
  /**
   * Legacy flag promoted to its own column by migration 035. New
   * Principal creation no longer derives it from reserved names.
   */
  role_principal?: boolean;
  /**
   * Optional manager Principal. `X.reports_to = Y` ⇒ X reports to Y —
   * the edge forms the reporting hierarchy in `org-chart` Docos.
   * Omitted means top-of-chain; the org-chart template asks
   * top-of-chain Principals to explain why in body_md (no manager
   * above, founder, root agent, external authority).
   */
  reports_to?: EntityId<"principal">;
  /**
   * Secondary / dotted-line (matrix) managers. `reports_to` carries the
   * single primary (solid-line) manager that forms the org tree; this
   * list carries additional matrix reporting lines (project lead,
   * functional vs operational manager) that layer on top without
   * reparenting the node. Each materializes as a `dotted_reports_to`
   * edge; the org-tree perspective draws them dashed.
   */
  dotted_reports_to?: EntityId<"principal">[];
  /**
   * Other seats filled by the same occupant. A Principal is a *seat*
   * (role + current occupant); when one person/agent holds several
   * seats (the CEO who also acts as VP Eng), link the seats with
   * `same_occupant_as` so the chart can tell it's one occupant rather
   * than duplicating them. Materializes as a `same_occupant_as` edge.
   */
  same_occupant_as?: EntityId<"principal">[];
}

// ─── Doco (root entity) ───────────────────────────────────────────────────

export interface DocoMember {
  /** Membership is at the OAuth-identity layer; the field name reflects that. */
  user_id: EntityId<"user">;
  role: "owner" | "maintainer" | "contributor" | "viewer";
  permissions: ("read" | "write" | "execute" | "admin")[];
}

export interface DocoImport {
  doco: string;
  ref: string;
  as: string;
  include?: string[];
}

/** Doco.owner_id is polymorphic: User (user/agent) OR Organization. */
export type OwnerRef = EntityId<"user"> | EntityId<"organization">;

export interface Doco {
  id: EntityId<"doco">;
  handle: string;
  visibility: "private" | "public";
  default_branch?: string;
  owner_id: OwnerRef;
  summary?: string;
  created_at?: string;
  created_by?: EntityId<"user">;
  updated_at?: string;
  updated_by?: EntityId<"user">;
  lifecycle?: Lifecycle;
  members?: DocoMember[];
  imports?: DocoImport[];
}

// ─── Intent ───────────────────────────────────────────────────────────────

export interface Intent extends CommonFields {
  node_type: "intent";
  /** Full prose: what someone wants, why, success criteria. */
  intent: string;
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

export interface Idea extends CommonFields {
  node_type: "idea";
  /** Full prose: the idea, context, tradeoffs. */
  idea: string;
  /** Who proposed it. User (the OAuth identity), not a principal. */
  proposer_id?: EntityId<"user">;
  promoted_to?: EntityId; // Intent / Decision / Action when picked up
  rejection_reason?: string;
}

// ─── Rule ─────────────────────────────────────────────────────────────────

export type RuleKind = "guidance" | "tagged";

/**
 * Authoring predicate — the structured shape the engine evaluates at
 * write time. Stored as `Rule.predicate`.
 *
 * `when_node_type` filters a predicate to candidates of specific node
 * types. The membership gates (`requires_node_type` /
 * `requires_entity_type`) carry no `when_node_type`, so they fire against
 * every candidate — including policy captures. A gate that must admit
 * in-Doco policy authoring therefore uses `requires_entity_type` and
 * lists the policy types (a node-only gate would reject them).
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
  | { kind: "unique_field"; field: string; case_fold?: boolean; when_node_type?: NodeType[] }
  | { kind: "requires_node_type"; node_types: NodeType[] }
  /**
   * Like `requires_node_type` but matches on the candidate's id prefix,
   * so it accepts any entity type — including the two policy kinds. Used
   * by every template whose membership gate must admit in-Doco policy
   * authoring (glossaries, business-processes, org-chart): a node-only
   * gate blocks policy captures because they carry no `node_type`.
   */
  | { kind: "requires_entity_type"; entity_types: EntityType[] }
  | { kind: "probabilistic"; spec: string; when_node_type?: NodeType[] }
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
   * existing Principal (role-persona). Used to reject e.g. an Action
   * whose `actor_id` is a free-text string rather than a real
   * principal id.
   *
   * Post-rename: principals no longer carry a `type` field — the
   * person/agent split moved to User. The predicate no longer
   * constrains by `allowed_principal_types`; it just enforces that the
   * field resolves to an existing principal.
   */
  | {
      kind: "requires_field_resolves_to_principal";
      field: string;
      when_node_type?: NodeType[];
    }
  | { kind: "descriptive"; spec: string; when_node_type?: NodeType[] };

export interface Rule extends CommonFields {
  node_type: "rule";
  /** Full prose: the rule statement, rationale, scope, exceptions. */
  rule: string;
  kind?: RuleKind;
  predicate?: AuthoringPredicate;
  fires_when_node_lifecycle?: Lifecycle[];
  modality?: "must" | "must_not" | "should" | "should_not";
  severity?: "blocker" | "warning" | "info";
  phase?: "declared" | "pre" | "post" | "invariant";
  expected?: unknown;
  on_violation?: "block" | "warn" | "log";
}

// ─── Policies ─────────────────────────────────────────────────────────────
//
// Policies carry a type-named prose column (`policy`) — the one-line
// rule statement — instead of the legacy `summary`. Renamed by
// migration 038 so the surface matches the 9 migrated node types
// (intent / decision / rule / action / log / eval / state / idea /
// reference) which each carry their own type-named column.

export interface GuidancePolicy extends CommonFields {
  policy_kind: "guidance";
  /** The one-line guidance statement. */
  policy: string;
  /** Optional long-form rationale. */
  body_md?: string;
}

export interface NodeAuthoringPolicy extends CommonFields {
  policy_kind: "node_authoring";
  /** The one-line rule statement that describes the check. */
  policy: string;
  /** Optional long-form rationale. */
  body_md?: string;
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

export interface Decision extends CommonFields {
  node_type: "decision";
  /** Full prose: the decision narrative — context, chosen path, why. */
  decision: string;
  intent_ids?: EntityId<"intent">[];
  question: string;
  chosen: string | null; // null while lifecycle is "drafting"
  alternatives?: DecisionAlternative[];
  rules_consulted?: EntityId<"rule">[];
  /**
   * Who decided. References the Principal (role-persona) who made the
   * call — matches the capture-API contract (PR #66). Stored as the
   * promoted `decided_by` column on the unified `nodes` table; the
   * node-table collapse dropped the old inter-node FK (migration 066),
   * so the column carries no database foreign key — existence is
   * app-enforced, like edges. Pre-rename data used User ids here;
   * migration 025 backfilled.
   */
  decided_by: EntityId<"principal">;
  decided_at: string;
  superseded_by?: EntityId<"decision"> | null;
}

// ─── Action (designed step) ───────────────────────────────────────────────

export interface Action extends CommonFields {
  node_type: "action";
  /** Full prose: past-tense verb phrase describing what was done + context. */
  action: string;
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

export interface Log extends CommonFields {
  node_type: "log";
  /** Full prose: what happened, when, in what state. */
  log: string;
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

export interface Eval extends CommonFields {
  node_type: "eval";
  /** Full prose: what's being checked, plus rationale. */
  eval: string;
  kind?: EvalKind;
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

export interface Reference extends CommonFields {
  node_type: "reference";
  /** Full prose: human-readable label for the external thing. */
  reference: string;
  ref_type: "file" | "url" | "ticket" | "commit" | "document" | "other";
  locator: string;
  /**
   * Short citation string — promoted out of `data` jsonb to its own
   * column by migration 035. Optional; used as the in-prose-mention
   * shortcut (e.g. "see [ADR-085]").
   */
  citation?: string | null;
  /**
   * Display title — promoted out of `data` jsonb to its own column by
   * migration 035. Distinct from `reference` (the prose label) when a
   * caller wants the source's own title preserved separately.
   */
  title?: string | null;
  content_hash?: string | null;
}

// ─── State ────────────────────────────────────────────────────────────────

export type StateKind = "initial" | "intermediate" | "terminal";

export interface State extends CommonFields {
  node_type: "state";
  /** Full prose: state description, invariants explained. */
  state: string;
  kind: StateKind;
  intent_ids?: EntityId<"intent">[];
  invariants?: string[];
}

// ─── Organization ─────────────────────────────────────────────────────────

export interface OrganizationMember {
  user_id: EntityId<"user">;
  role: "owner" | "admin" | "member" | "viewer";
  permissions?: ("read" | "write" | "execute" | "admin")[];
}

export interface Organization extends SummarizedFields {
  handle: string;
  display_name: string;
  description?: string;
  visibility?: "private" | "public";
  members?: OrganizationMember[];
}

// ─── Discriminated unions ─────────────────────────────────────────────────

/** The 10 node types. */
export type Node =
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

/** The 2 policy types. */
export type Policy = GuidancePolicy | NodeAuthoringPolicy;

/** Every entity across all categories. */
export type Entity = Node | Policy | User | Doco | Organization;

/** Look up a Node interface by its `node_type` literal. */
export type NodeByType<T extends Node["node_type"]> = Extract<Node, { node_type: T }>;

/** Look up a Policy interface by its `policy_kind` literal. */
export type PolicyByKind<T extends Policy["policy_kind"]> = Extract<Policy, { policy_kind: T }>;
