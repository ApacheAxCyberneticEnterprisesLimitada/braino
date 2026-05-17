import { describe, expect, it } from "vitest";
import { findScopeTemplate } from "../index.js";

describe("scope templates", () => {
  it("seeds semantic membership for user-flows", () => {
    const tpl = findScopeTemplate("user-flows");
    const predicates = tpl?.rules.map((rule) => rule.predicate);

    expect(predicates).toContainEqual({
      kind: "probabilistic",
      spec: "A node belongs in user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature.",
    });
  });
});
