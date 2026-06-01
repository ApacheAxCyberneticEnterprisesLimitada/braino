import {
  type Entity,
  MANAGED_EDGE_TYPES,
  MANAGED_FIELD_TO_EDGE,
  isEntityId,
  managedEdgePropsForField,
  managedRelationSpecForField,
} from "@doco/shared";
import { entityTypeFromId } from "./entity-id.js";

export interface Edge {
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  edge_props?: Record<string, unknown>;
}

/**
 * Derive edges from an entity's ID-shaped fields per D-017 ("fields-as-edges").
 * Returns one edge per ID reference; field name → edge type via FIELD_TO_EDGE_TYPE.
 */
export function deriveEdges(entity: Entity): Edge[] {
  const edges: Edge[] = [];
  const fromId = entity.id;
  // Entity interfaces use per-category discriminators (node_type /
  // policy_kind / kind), not a uniform entity_type. Derive from the
  // ID prefix instead — it's always present + matches the table name.
  const fromType = entityTypeFromId(fromId);

  function emit(field: string, target: unknown, props?: Record<string, unknown>): void {
    if (typeof target !== "string") return;
    if (target.includes(":")) return; // cross-Doco, skip for now
    if (!isEntityId(target)) return;
    if (target === fromId) return; // self-edges add no graph info (e.g. bootstrap principal's `created_by`)
    const m = /^(\w+)_/.exec(target);
    if (!m) return;
    const toType = m[1] as string;
    const relationSpec = managedRelationSpecForField(field);
    const edgeProps = relationSpec ? managedEdgePropsForField(field, props) : props;
    edges.push({
      from_id: fromId,
      from_node_type: fromType,
      to_id: target,
      to_node_type: toType,
      edge_type: relationSpec?.edgeType ?? FIELD_TO_EDGE_TYPE[field] ?? field,
      ...(edgeProps ? { edge_props: edgeProps } : {}),
    });
  }

  // Walk every key of the entity object.
  const obj = entity as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (SKIP_FIELDS.has(field)) continue; // structural metadata, not a relationship
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string") emit(field, v);
        else if (v && typeof v === "object") {
          // E.g. Reasoning.premises[].ref, Doco.members[].principal_id, Doco.imports[]
          handleObject(field, v as Record<string, unknown>, emit);
        }
      }
    } else if (typeof value === "string") {
      emit(field, value);
    } else if (typeof value === "object") {
      // Could be a single nested object — recurse minimally.
      handleObject(field, value as Record<string, unknown>, emit);
    }
  }
  return edges;
}

function handleObject(
  parentField: string,
  obj: Record<string, unknown>,
  emit: (field: string, target: unknown, props?: Record<string, unknown>) => void,
): void {
  if (parentField === "sequence_to" && typeof obj.target === "string") {
    const props = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "target"));
    emit("sequence_to", obj.target, Object.keys(props).length > 0 ? props : undefined);
    return;
  }
  if (parentField === "preceded_by") {
    const target = typeof obj.target === "string" ? obj.target : obj.ref;
    if (typeof target === "string") {
      emit("preceded_by", target);
      return;
    }
  }
  // Reasoning.premises[]: { entity_type, ref, as }
  if (typeof obj.ref === "string" && parentField === "premises") {
    emit("premise", obj.ref, { as: obj.as });
    return;
  }
  // Doco.members[]: { principal_id, role, permissions }
  if (typeof obj.principal_id === "string") {
    emit("member", obj.principal_id, { role: obj.role, permissions: obj.permissions });
    return;
  }
  // Doco.imports[]: { doco, ref, as, include }
  if (typeof obj.doco === "string" && parentField === "imports") {
    // Cross-Doco, skip
    return;
  }
  // Generic: emit any direct ID-valued sub-fields
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") emit(`${parentField}.${k}`, v);
  }
}

/**
 * Fields whose values are NOT relationships, even if they happen to look
 * ID-shaped. Skipped entirely from the recursive walk.
 *
 * - `id` / `doco_id`: structural; emitting them would create noise (self-edge
 *   or one-per-page).
 * - `inputs` / `outputs`: free-form bags on Action. Their nested keys are
 *   ad-hoc descriptive fields ("founder_direction", "asset_files",
 *   "completion_note") not relationships. Walking them produced noisy
 *   pseudo-edges like `inputs.assets_provided_by`. Per ADR-091.
 * - `created_by` / `updated_by`: provenance audit columns on every entity.
 *   The DB still tracks them as scalar columns; we just don't materialize
 *   them as graph edges anymore (they were already filtered from the graph
 *   render, and they carried no traversal value).
 *
 * IMPORTANT for policy authors: a `requires_edge` / `forbids_edge`
 * predicate works off the edges derived here. If your check targets an
 * id that lives under one of these field names (or nested under one), the
 * edge will not exist and the predicate will silently never match.
 * The constant is exported so callers (e.g. `validateEdgeType` in the
 * capture layer) can surface this at write time.
 */
export const SKIP_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "doco_id",
  "inputs",
  "outputs",
  "created_by",
  "updated_by",
  // Eval's input/expected/actual carry arbitrary scalars (test fixtures) —
  // their nested ID-shaped values aren't relationships.
  "input",
  "expected",
  "actual",
]);

/**
 * Field name → canonical edge type. Anything not listed defaults to the
 * field name. Exported so capture-time predicate validation can warn when a
 * predicate's `edge_type` matches a *field name* listed here (e.g.
 * `intent_ids`) — the engine sees the *mapped* type (`serves`) and the
 * predicate would never match.
 */
export const FIELD_TO_EDGE_TYPE: Record<string, string> = {
  ...MANAGED_FIELD_TO_EDGE,
  target: "acts_on",
  premise: "premise",
  conclusion_ref: "concludes",
  member: "member_of",
};

/**
 * The five promoted relationship columns retired by the "edges as the authored
 * source of truth" refactor (option (i)) each project exactly one edge type.
 * The capture path authors these as first-class edges; Stage 2 drops the
 * columns. Every other relationship `deriveEdges` emits stays a node field for
 * now — those columns are not being dropped.
 */
export const MANAGED_RELATION_EDGE_TYPES: readonly string[] = MANAGED_EDGE_TYPES;

const MANAGED_EDGE_TYPE_SET: ReadonlySet<string> = new Set(MANAGED_RELATION_EDGE_TYPES);

/**
 * The subset of `deriveEdges` output the capture path persists as first-class
 * edges: exactly the edges projected by the five promoted columns Stage 2
 * drops. Because the managed types are all node→node, a non-node ref like
 * `idea.proposer_id` (→ user) is naturally excluded.
 */
export function managedEdges(entity: Entity): Edge[] {
  return deriveEdges(entity).filter((e) => MANAGED_EDGE_TYPE_SET.has(e.edge_type));
}

/** A live managed-type edge already in the DB, as needed for reconciliation. */
export interface ExistingManagedEdge {
  id: string;
  edge_type: string;
  to_id: string;
  edge_props?: Record<string, unknown> | null;
  origin: "authored" | "field";
}

export interface ManagedEdgeReconciliation {
  /** Desired edges with no live edge of the same (edge_type, to_id) yet. */
  toCreate: Edge[];
  /** Ids of live origin='field' edges the node no longer projects. */
  toRetireIds: string[];
}

/**
 * Diff the edges a node should project (`desired`, from `managedEdges`) against
 * the live managed-type edges already stored (`existing`). Returns the
 * create/retire plan the capture path runs in one transaction.
 *
 * - Idempotent: identical input → empty plan, so a full backfill/reindex never
 *   churns edge history.
 * - origin='authored' edges are never auto-retired, and a desired edge that is
 *   already live (as either origin) is not re-created — the live-unique index
 *   would reject the duplicate anyway.
 */
export function reconcileManagedEdges(
  desired: Edge[],
  existing: ExistingManagedEdge[],
): ManagedEdgeReconciliation {
  const key = (edgeType: string, toId: string, props?: Record<string, unknown> | null): string => {
    const role = typeof props?.role === "string" ? props.role : "";
    const sourceField = typeof props?.source_field === "string" ? props.source_field : "";
    return `${edgeType}\0${toId}\0${sourceField}\0${role}`;
  };
  const desiredKeys = new Set(desired.map((e) => key(e.edge_type, e.to_id, e.edge_props)));
  const liveKeys = new Set(existing.map((e) => key(e.edge_type, e.to_id, e.edge_props)));
  return {
    toCreate: desired.filter((e) => !liveKeys.has(key(e.edge_type, e.to_id, e.edge_props))),
    toRetireIds: existing
      .filter(
        (e) => e.origin === "field" && !desiredKeys.has(key(e.edge_type, e.to_id, e.edge_props)),
      )
      .map((e) => e.id),
  };
}
