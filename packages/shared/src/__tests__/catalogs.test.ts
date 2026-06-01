import { describe, expect, it } from "vitest";
import { EDGE_TYPES } from "../access-types.js";
import { NODE_TYPES } from "../branded.js";
import { CAPTURE_SCHEMAS, renderCaptureCheatsheet } from "../capture-schema.js";
import { NODE_CATALOG } from "../entity-catalog.js";
import { RELATION_CATALOG } from "../relation-catalog.js";

describe("shared catalogs", () => {
  it("derives node type tokens from the node catalog", () => {
    expect(NODE_TYPES).toEqual(Object.keys(NODE_CATALOG));
  });

  it("derives edge write tokens from the relation catalog", () => {
    expect(EDGE_TYPES).toEqual(Object.keys(RELATION_CATALOG));
  });

  it("accepts a `role` prop on every relation that documents role examples", () => {
    // A relation that advertises roleExamples MUST accept a `role` prop, or
    // the changeset relate path silently drops the role (relationProps filters
    // on acceptsProps) and writes a role-less edge — which then fails the
    // role-aware authoring policies and forces a duplicate, role-bearing edge.
    for (const [kind, entry] of Object.entries(RELATION_CATALOG)) {
      if (entry.roleExamples && entry.roleExamples.length > 0) {
        expect(entry.acceptsProps ?? [], `${kind} must accept a role prop`).toContain("role");
      }
    }
    expect(RELATION_CATALOG.supports.acceptsProps).toContain("role");
    expect(RELATION_CATALOG.attributed_to.acceptsProps).toContain("role");
    expect(RELATION_CATALOG.constrained_by.acceptsProps).toContain("role");
    expect(RELATION_CATALOG.has_parent.acceptsProps).toContain("role");
    // flows_to carries label/condition metadata, not a role.
    expect(RELATION_CATALOG.flows_to.acceptsProps ?? []).not.toContain("role");
  });

  it("keeps chosen optional in the reusable Decision capture schema", () => {
    const chosen = CAPTURE_SCHEMAS.decision.fields.find((field) => field.name === "chosen");
    expect(chosen?.requirement).toBe("optional");
    expect(renderCaptureCheatsheet()).toContain("chosen?");
  });
});
