import { describe, expect, it } from "vitest";
import { EDGE_TYPES } from "../access-types.js";
import {
  MANAGED_EDGE_TYPES,
  MANAGED_FIELD_TO_EDGE,
  MANAGED_RELATION_FIELDS,
  MANAGED_RELATION_FIELD_SPECS,
  cardinalityForManagedField,
  fieldForManagedEdge,
  isManagedRelationField,
  managedEdgePropsForField,
  managedRelationSpecForField,
  stripManagedEdgeProps,
} from "../managed-relations.js";

describe("managed relation fields", () => {
  it("folds field-specific authoring inputs into the canonical edge families", () => {
    expect(MANAGED_EDGE_TYPES).toEqual(EDGE_TYPES);
    expect(MANAGED_FIELD_TO_EDGE).toMatchObject({
      sequence_to: "flows_to",
      preceded_by: "flows_to",
      intent_ids: "supports",
      decision_ids: "supports",
      target_ref: "supports",
      implemented_by: "supports",
      gated_by: "constrained_by",
      rules_consulted: "constrained_by",
      actor_id: "attributed_to",
      owner_id: "attributed_to",
      stakeholders: "attributed_to",
      decided_by: "attributed_to",
      parent_intent_id: "has_parent",
      reports_to: "has_parent",
      dotted_reports_to: "has_parent",
      born_from: "derived_from",
      template_id: "derived_from",
      superseded_by: "replaces",
      relates_to: "relates_to",
      same_occupant_as: "relates_to",
    });
  });

  it("keeps role and owner metadata beside the canonical edge family", () => {
    expect(MANAGED_RELATION_FIELDS).toContain("target_ref");
    expect(MANAGED_RELATION_FIELD_SPECS.target_ref).toMatchObject({
      edgeType: "supports",
      cardinality: "one",
      role: "tests",
      owners: ["eval", "reference"],
    });
    expect(MANAGED_RELATION_FIELD_SPECS.reports_to).toMatchObject({
      edgeType: "has_parent",
      cardinality: "one",
      role: "reports_to",
      owners: ["principal"],
    });
  });

  it("recognizes managed relation fields", () => {
    expect(isManagedRelationField("actor_id")).toBe(true);
    expect(isManagedRelationField("random_pointer")).toBe(false);
    expect(managedRelationSpecForField("actor_id")).toMatchObject({
      field: "actor_id",
      edgeType: "attributed_to",
      role: "performed_by",
    });
    expect(managedRelationSpecForField("random_pointer")).toBeNull();
  });

  it("adds source_field and role props without losing authored edge props", () => {
    expect(managedEdgePropsForField("sequence_to", { label: "yes" })).toEqual({
      label: "yes",
      role: "sequence",
      source_field: "sequence_to",
    });
    expect(managedEdgePropsForField("random_pointer", { label: "kept" })).toEqual({
      label: "kept",
    });
  });

  it("resolves fields from source_field first and role as a fallback", () => {
    expect(
      fieldForManagedEdge("flows_to", {
        source_field: "preceded_by",
        role: "sequence",
      }),
    ).toBe("preceded_by");
    expect(fieldForManagedEdge("flows_to", { role: "sequence" })).toBe("sequence_to");
    expect(
      fieldForManagedEdge("flows_to", { source_field: "actor_id", role: "performed_by" }),
    ).toBeNull();
    expect(fieldForManagedEdge("supports", { source_field: "not_managed", role: "tests" })).toBe(
      "target_ref",
    );
    expect(fieldForManagedEdge("supports", null)).toBeNull();
  });

  it("returns field cardinality and strips managed edge props for hydrated data", () => {
    expect(cardinalityForManagedField("superseded_by")).toBe("one");
    expect(cardinalityForManagedField("implemented_by")).toBe("many");
    expect(
      stripManagedEdgeProps({
        role: "serves",
        source_field: "intent_ids",
        confidence: 0.9,
      }),
    ).toEqual({ confidence: 0.9 });
    expect(stripManagedEdgeProps(null)).toEqual({});
  });
});
