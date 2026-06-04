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

  it("carries no `role` prop or roleExamples on any relation", () => {
    // Edge `role` is fully removed: an edge's meaning is derived from its TYPE
    // plus its endpoint node types, never from a `props.role` tag. No relation
    // may advertise a `role` prop or carry roleExamples, or the retired concept
    // would leak back in via the changeset relate path / authoring contract.
    for (const [kind, entry] of Object.entries(RELATION_CATALOG)) {
      expect(entry.acceptsProps ?? [], `${kind} must not accept a role prop`).not.toContain("role");
      expect(
        (entry as { roleExamples?: unknown }).roleExamples,
        `${kind} must not carry roleExamples`,
      ).toBeUndefined();
    }
  });

  it("keeps chosen optional in the reusable Decision capture schema", () => {
    const chosen = CAPTURE_SCHEMAS.decision.fields.find((field) => field.name === "chosen");
    expect(chosen?.requirement).toBe("optional");
    expect(renderCaptureCheatsheet()).toContain("chosen?");
  });
});
