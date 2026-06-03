/**
 * TypeScript types for Doco entities. The source of truth for entity
 * shape — there is no parallel JSON Schema. Runtime validation checks
 * load + cross-reference resolution only.
 *
 * Post-rename vocabulary:
 *   - Nodes (10): graph-knowledge entities (intent, idea, rule,
 *     decision, action, log, eval, reference, state, principal)
 *   - Policies (1): Doco-level authoring metadata — one `policies` table,
 *     classified by `kind: "suggestion" | "deterministic" | "probabilistic"`
 *   - User (1): OAuth identity layer (separate from principal)
 *   - Doco, Workspace: workspace + workspace containers
 *
 * Per-category discriminator fields (matches stored data jsonb):
 *   - Nodes   → `node_type: NodeType`
 *   - Policies → `kind: "suggestion" | "deterministic" | "probabilistic"`
 *   - User → human OAuth identity
 *   - Doco, Workspace → no per-row discriminator
 *
 * `created_by` / `updated_by` reference users (the OAuth identity).
 * Graph relationships live in first-class edge rows.
 */

import type { EntityId, EntityType, NodeType } from "./branded.js";

/**
 * Node lifecycle stages, in canonical progression order:
 *   drafting → queued → active → retired
 * `active` is the in-force stage (formerly `asserted`); `queued` is
 * provisional-but-ready (e.g. an open GitHub PR awaiting approval).
 * Policies use a narrower two-stage lifecycle — see `PolicyLifecycle`.
 */
export type Lifecycle = "drafting" | "queued" | "active" | "retired";

/**
 * Policies only ever occupy two stages: `active` (in force) or `retired`
 * (superseded / withdrawn). They never enter the node-only
 * `drafting`/`queued` stages.
 */
export type PolicyLifecycle = "active" | "retired";

export type Outcome = "succeeded" | "failed";

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

/**
 * User — host-scoped human OAuth identity.
 * Authored nodes via `created_by` / `updated_by`. Member of workspaces/docos
 * via `member_of` edges.
 *
 * NOT on the graph as a node — users are an identity layer.
 * Use `Principal` (the node) when documenting a role/persona that
 * participates in a flow.
 */
export interface User {
  id: EntityId<"user">;
  github_id?: string;
  github_login: string;
  email?: string;
  avatar_url?: string;
  created_at: string;
  deactivated_at?: string;
}

// ─── Principal (role-persona — node type) ───────────────────────────────

/**
 * Principal — documented role/persona that participates in flows.
 * Related to work through edge rows. Slimmed from the pre-rename Principal
 * which also held OAuth identity; that concern is now `User`.
 */
// Principal carries `name` (display label) + `body_md` (everything else), so it
// extends CommonFields rather than SummarizedFields.
export interface Principal extends CommonFields {
  node_type: "principal";
  /** Markdown body — the canonical narrative for the Principal. */
  body_md?: string;
  /** Display label for the Principal. Other nodes reference Principals
   *  by id; duplicate names are allowed. */
  name: string;
  /** Principal role marker used by system-authored templates. */
  role_principal?: boolean;
}

// ─── Doco (root entity) ───────────────────────────────────────────────────

/** Doco.owner_id is polymorphic: User OR Workspace. */
export type OwnerRef = EntityId<"user"> | EntityId<"workspace">;

export interface Doco {
  id: EntityId<"doco">;
  handle: string;
  visibility: "private" | "public";
  owner_id: OwnerRef;
  created_at?: string;
  created_by?: EntityId<"user">;
  updated_at?: string;
  updated_by?: EntityId<"user">;
  lifecycle?: Lifecycle;
}

// ─── Intent ───────────────────────────────────────────────────────────────

export interface Intent extends CommonFields {
  node_type: "intent";
  /** Full prose: what someone wants, why, success criteria. */
  intent: string;
  priority?: "p0" | "p1" | "p2" | "p3";
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

/**
 * Authoring predicate — the structured shape templates use to author
 * policies, converted to a runtime `Policy` (`PolicyKind` + `PolicyPredicate`)
 * at seed time. (`Rule` *nodes* carry a prose `predicate` string, not this.)
 *
 * `when_node_type` filters a predicate to candidates of specific node
 * types. Membership gates (`requires_node_type` / `requires_entity_type`)
 * carry no `when_node_type`, so they fire against every node candidate.
 * Policy records are Doco-scoped metadata; the evaluator lets them pass
 * membership gates without forcing each template to list policy entity
 * types as domain content.
 */
export type AuthoringPredicate =
  | {
      kind: "requires_edge";
      edge_type: string;
      target_node_type?: string;
      when_node_type?: NodeType[];
    }
  | {
      kind: "requires_edge_role";
      edge_type: string;
      edge_role: string;
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
   * for callers that intentionally allow broader entity categories than
   * graph nodes.
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
  /** Field-resolution check: `entity[field]` must be the id of an existing Principal. */
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
  /** Prose or machine-checkable assertion the rule states (enforcement is
   *  carried by `Policy` records, not by this string). */
  predicate?: string;
  fires_when_node_lifecycle?: Lifecycle[];
  severity?: "blocker" | "warning" | "info";
  phase?: "declared" | "pre" | "post" | "invariant";
  on_violation?: "block" | "warn" | "log";
}

// ─── Policies ─────────────────────────────────────────────────────────────
//
// Every policy is an authoring policy: one `policies` table, one `policy`
// entity type. The standalone `kind` classifier drives both evaluation and
// rendering:
//   - "suggestion"    — advisory; surfaced to agents, never enforced.
//   - "probabilistic" — LLM-judged at write time.
//   - "deterministic" — engine-checked at write time.
//
// `suggestion` and `probabilistic` carry a single natural-language
// `agent_instruction`. `deterministic` carries a structured predicate whose
// `sub_kind` selects the engine check.

export type PolicyKind = "suggestion" | "deterministic" | "probabilistic";

/**
 * Deterministic predicate — the structured, engine-checkable shape evaluated
 * at write time. `sub_kind` selects the check; the remaining fields are its
 * parameters. (This is `AuthoringPredicate` with `kind` lifted out to
 * `sub_kind`, so the policy's own `kind` can stand alone.)
 */
export type DeterministicPredicate =
  | {
      sub_kind: "requires_edge";
      edge_type: string;
      target_node_type?: string;
      when_node_type?: NodeType[];
    }
  | {
      sub_kind: "requires_edge_role";
      edge_type: string;
      edge_role: string;
      target_node_type?: string;
      when_node_type?: NodeType[];
    }
  | {
      sub_kind: "forbids_edge";
      edge_type: string;
      target_node_type?: string;
      when_node_type?: NodeType[];
    }
  | { sub_kind: "requires_field"; fields: string[]; when_node_type?: NodeType[] }
  | { sub_kind: "forbids_field"; fields: string[]; when_node_type?: NodeType[] }
  | { sub_kind: "unique_field"; field: string; case_fold?: boolean; when_node_type?: NodeType[] }
  | { sub_kind: "requires_node_type"; node_types: NodeType[] }
  | { sub_kind: "requires_entity_type"; entity_types: EntityType[] }
  | {
      sub_kind: "graph-completeness";
      list_field: string;
      edge_type: string;
      incoming_node_type: NodeType;
      incoming_field_must_match: string;
      when_node_type?: NodeType[];
    }
  | {
      sub_kind: "requires_field_resolves_to_principal";
      field: string;
      when_node_type?: NodeType[];
    };

/** The deterministic check selectors — the options a deterministic policy picks from. */
export type DeterministicSubKind = DeterministicPredicate["sub_kind"];

/**
 * Suggestion / probabilistic predicate. A single natural-language
 * instruction: surfaced to agents (suggestion) or fed to the LLM judge
 * (probabilistic). `when_node_type` optionally scopes a probabilistic check.
 */
export interface AgentInstructionPredicate {
  agent_instruction: string;
  when_node_type?: NodeType[];
}

export type PolicyPredicate = AgentInstructionPredicate | DeterministicPredicate;

export interface Policy extends CommonFields {
  /** Standalone classifier — drives evaluation and rendering. */
  kind: PolicyKind;
  /**
   * suggestion / probabilistic → `{ agent_instruction }`
   * deterministic              → `{ sub_kind, ...params }`
   */
  predicate: PolicyPredicate;
  /** Skip unless the candidate's lifecycle is in this list. */
  fires_when_node_lifecycle?: Lifecycle[];
  /** Defaults to "block". Irrelevant for suggestions (advisory only). */
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
  question: string;
  chosen: string | null; // null while lifecycle is "drafting"
  alternatives?: DecisionAlternative[];
  decided_at: string;
}

// ─── Action (designed step) ───────────────────────────────────────────────

export interface Action extends CommonFields {
  node_type: "action";
  /** Full prose: past-tense verb phrase describing what was done + context. */
  action: string;
  verb: string;
  target?: EntityId;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  triggered_by?: EntityId<"action">[];
}

// ─── Log (recorded happening) ─────────────────────────────────────────────

export interface Log extends CommonFields {
  node_type: "log";
  /** Full prose: what happened, when, in what state. */
  log: string;
  verb: string;
  happened_at: string;
  target?: EntityId;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
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
  /** Short citation string used as the in-prose-mention shortcut. */
  citation?: string | null;
  /** Display title distinct from `reference` when the source title matters. */
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
  invariants?: string[];
}

// ─── Workspace ─────────────────────────────────────────────────────────

export interface WorkspaceMember {
  user_id: EntityId<"user">;
  role: "owner" | "admin" | "member" | "viewer";
  permissions?: ("read" | "write" | "execute" | "admin")[];
}

export interface Workspace extends SummarizedFields {
  handle: string;
  display_name: string;
  description?: string;
  visibility?: "private" | "public";
  members?: WorkspaceMember[];
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

/** Every entity across all categories. (`Policy` is a single interface now.) */
export type Entity = Node | Policy | User | Doco | Workspace;
