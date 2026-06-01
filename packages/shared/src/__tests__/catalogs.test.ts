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

  it("keeps chosen optional in the reusable Decision capture schema", () => {
    const chosen = CAPTURE_SCHEMAS.decision.fields.find((field) => field.name === "chosen");
    expect(chosen?.requirement).toBe("optional");
    expect(renderCaptureCheatsheet()).toContain("chosen?");
  });
});
