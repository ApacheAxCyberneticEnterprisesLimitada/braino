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
    expect(predicates).toContainEqual({
      kind: "probabilistic",
      spec: 'Action nodes in user-flows pass the summary style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
      when_node_type: ["action"],
    });
  });
});
