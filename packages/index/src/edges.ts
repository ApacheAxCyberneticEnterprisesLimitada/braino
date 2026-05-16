import { type Entity, isEntityId } from "@doco/shared";

export type EdgeAttribution = "explicit" | "doco-auto";

export interface Edge {
  from_id: string;
  from_node_type: string;
  to_id: string;
  to_node_type: string;
  edge_type: string;
  edge_props?: Record<string, unknown>;
  /**
   * Where the edge came from: 'explicit' when the source entity declared
   * the ref in its frontmatter (the normal case); 'doco-auto' when the
   * LLM auto-detected it (per `llm-auto-edge-detection-on-capture` ADR).
   * Auto edges are weighted lower in PageRank and rendered differently.
   * Defaults to 'explicit'.
   */
  attribution?: EdgeAttribution;
}

/**
 * Derive edges from an entity's ID-shaped fields per D-017 ("fields-as-edges").
 * Returns one edge per ID reference; field name → edge type via FIELD_TO_EDGE_TYPE.
 */
export function deriveEdges(entity: Entity): Edge[] {
  const edges: Edge[] = [];
  const fromId = entity.id;
  const fromType = entity.node_type as string;

  function emit(
    field: string,
    target: unknown,
    props?: Record<string, unknown>,
    attribution: EdgeAttribution = "explicit",
  ): void {
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
      attribution,
      ...(props ? { edge_props: props } : {}),
    });
  }

  // Walk every key of the entity object.
  const obj = entity as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (SKIP_FIELDS.has(field)) continue; // structural metadata, not a relationship
    if (field === AUTO_EDGES_FIELD) continue; // handled below — needs special attribution
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

  // Auto-detected edges, per the `llm-auto-edge-detection-on-capture` ADR.
  // The capture/auto-edge helper writes these into the frontmatter as
  //   auto_edges: [{ to_id, edge_type, reason }]
  // We emit each as an Edge with attribution: 'doco-auto'. PageRank then
  // weights them lower than explicit edges.
  const autoEdges = obj[AUTO_EDGES_FIELD];
  if (Array.isArray(autoEdges)) {
    for (const ae of autoEdges) {
      if (!ae || typeof ae !== "object") continue;
      const rec = ae as Record<string, unknown>;
      const toId = rec.to_id;
      const edgeType = typeof rec.edge_type === "string" ? rec.edge_type : "relates_to";
      if (typeof toId !== "string" || !isEntityId(toId) || toId === fromId) continue;
      const m = /^(\w+)_/.exec(toId);
      if (!m) continue;
      const toType = m[1] as string;
      const props: Record<string, unknown> = {};
      if (typeof rec.reason === "string") props.reason = rec.reason;
      edges.push({
        from_id: fromId,
        from_node_type: fromType,
        to_id: toId,
        to_node_type: toType,
        edge_type: edgeType,
        attribution: "doco-auto",
        ...(Object.keys(props).length > 0 ? { edge_props: props } : {}),
      });
    }
  }
  return edges;
}

const AUTO_EDGES_FIELD = "auto_edges";

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
 * - `id` / `doco_id`: structural; emitting them would create noise (self-edge
 *   or one-per-page).
 * - `inputs` / `outputs`: free-form bags on Action. Their nested keys are
 *   ad-hoc descriptive fields ("founder_direction", "asset_files",
 *   "completion_note") not relationships. Walking them produced noisy
 *   pseudo-edges like `inputs.assets_provided_by`. Per ADR-091.
 */
const SKIP_FIELDS = new Set([
  "id",
  "doco_id",
  "inputs",
  "outputs",
  // Eval's input/expected/actual carry arbitrary scalars (test fixtures) —
  // their nested ID-shaped values aren't relationships.
  "input",
  "expected",
  "actual",
]);

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
  // A scope's main intent is still identified by this explicit field; in the
  // graph it reuses the existing "serves" relationship to Intent.
  primary_intent_id: "serves",
  // rule_id / target_id were the Evaluation-specific edges (evaluates_rule,
  // evaluated_on). The Evaluation node type is dropped — Eval uses
  // target_ref → tests instead.
  scopes: "in_scope_of", // ADR-078: was tags → "tagged"
  member: "member_of",
  follows: "follows", // ADR-077: BPMN ordering / dependency
  // EVO points at the entity it tests. The runner uses this edge to walk
  // from any node to its evals (and vice-versa for the eval page).
  target_ref: "tests",
};
