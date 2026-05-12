import { type Entity, isEntityId } from "@doco/shared";

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
  const fromType = entity.node_type as string;

  function emit(field: string, target: unknown, props?: Record<string, unknown>): void {
    if (typeof target !== "string") return;
    if (target.includes(":")) return; // cross-Doco, skip for now
    if (!isEntityId(target)) return;
    if (target === fromId) return; // self-edges add no graph info (e.g. bootstrap principal's `created_by`)
    const m = /^(\w+)_/.exec(target);
    if (!m) return;
    const toType = m[1] as string;
    edges.push({
      from_id: fromId,
      from_node_type: fromType,
      to_id: target,
      to_node_type: toType,
      edge_type: FIELD_TO_EDGE_TYPE[field] ?? field,
      ...(props ? { edge_props: props } : {}),
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
  // Reasoning.premises[]: { node_type, ref, as }
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
 * - `id`: the entity's own id; emitting it would create a self-edge.
 * - `doco_id`: structural Doco membership; every entity has one — no value
 *   in surfacing it as an edge on every page.
 * - `inputs`, `outputs`: free-form bags on Action. Their nested keys are
 *   ad-hoc descriptive fields ("founder_direction", "asset_files",
 *   "completion_note") not relationships. Walking them produced noisy
 *   pseudo-edges like `inputs.assets_provided_by` and
 *   `inputs.predecessor`. Per Phase 23 cleanup.
 */
const SKIP_FIELDS = new Set(["id", "doco_id", "inputs", "outputs"]);

/** Field name → canonical edge type. Anything not listed defaults to the field name. */
const FIELD_TO_EDGE_TYPE: Record<string, string> = {
  intent_ids: "serves",
  rules_consulted: "consults",
  decision_ids: "enacts",
  actor_id: "performed_by",
  target: "acts_on",
  author_id: "authored_by",
  premise: "premise",
  conclusion_ref: "concludes",
  parent_intent_id: "has_parent",
  stakeholders: "has_stakeholder",
  owner_id: "owned_by",
  created_by: "created_by",
  updated_by: "updated_by",
  born_from: "born_from",
  superseded_by: "superseded_by",
  rule_id: "evaluates_rule",
  target_id: "evaluated_on",
  scopes: "in_scope_of", // ADR-078: was tags → "tagged"
  member: "member_of",
  follows: "follows", // ADR-077: BPMN ordering / dependency
};
