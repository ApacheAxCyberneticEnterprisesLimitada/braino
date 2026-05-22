import { type Entity, isEntityId } from "@doco/shared";

export interface Synapse {
  from_id: string;
  from_neuron_type: string;
  to_id: string;
  to_neuron_type: string;
  synapse_type: string;
  synapse_props?: Record<string, unknown>;
}

/**
 * Derive synapses from an entity's ID-shaped fields per D-017 ("fields-as-synapses").
 * Returns one edge per ID reference; field name → edge type via FIELD_TO_SYNAPSE_TYPE.
 */
export function deriveSynapses(entity: Entity): Synapse[] {
  const synapses: Synapse[] = [];
  const fromId = entity.id;
  // Entity interfaces use per-category discriminators (neuron_type /
  // primitive_kind / kind), not a uniform entity_type. Derive from the
  // ID prefix instead — it's always present + matches the table name.
  const fromType = fromId.split("_").slice(0, -1).join("_");

  function emit(field: string, target: unknown, props?: Record<string, unknown>): void {
    if (typeof target !== "string") return;
    if (target.includes(":")) return; // cross-Doco, skip for now
    if (!isEntityId(target)) return;
    if (target === fromId) return; // self-synapses add no graph info (e.g. bootstrap principal's `created_by`)
    const m = /^(\w+)_/.exec(target);
    if (!m) return;
    const toType = m[1] as string;
    synapses.push({
      from_id: fromId,
      from_neuron_type: fromType,
      to_id: target,
      to_neuron_type: toType,
      synapse_type: FIELD_TO_SYNAPSE_TYPE[field] ?? field,
      ...(props ? { synapse_props: props } : {}),
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
  return synapses;
}

function handleObject(
  parentField: string,
  obj: Record<string, unknown>,
  emit: (field: string, target: unknown, props?: Record<string, unknown>) => void,
): void {
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
 *   pseudo-synapses like `inputs.assets_provided_by`. Per ADR-091.
 * - `created_by` / `updated_by`: provenance audit columns on every entity.
 *   The DB still tracks them as scalar columns; we just don't materialize
 *   them as graph synapses anymore (they were already filtered from the graph
 *   render, and they carried no traversal value).
 */
const SKIP_FIELDS = new Set([
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

/** Field name → canonical edge type. Anything not listed defaults to the field name. */
const FIELD_TO_SYNAPSE_TYPE: Record<string, string> = {
  intent_ids: "serves",
  rules_consulted: "consults",
  decision_ids: "enacts",
  actor_id: "performed_by",
  target: "acts_on",
  premise: "premise",
  conclusion_ref: "concludes",
  parent_intent_id: "has_parent",
  stakeholders: "has_stakeholder",
  owner_id: "owned_by",
  born_from: "born_from",
  superseded_by: "superseded_by",
  // rule_id / target_id were the Evaluation-specific synapses (evaluates_rule,
  // evaluated_on). The Evaluation node type is dropped — Eval uses
  // target_ref → tests instead.
  member: "member_of",
  follows: "follows", // ADR-077: BPMN ordering / dependency
  // EVO points at the entity it tests. The runner uses this edge to walk
  // from any node to its evals (and vice-versa for the eval page).
  target_ref: "tests",
};
