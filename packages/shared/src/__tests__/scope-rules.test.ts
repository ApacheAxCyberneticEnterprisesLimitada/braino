import { describe, expect, it } from "vitest";
import {
  globalScopeMembershipViolation,
  shouldRunAuthoringRuleForEntity,
} from "../scope-rules.js";

describe("shouldRunAuthoringRuleForEntity", () => {
  it("runs Global authoring rules even when the entity is not tagged Global", () => {
    expect(
      shouldRunAuthoringRuleForEntity({
        ruleScopeId: "scope_global",
        globalScopeId: "scope_global",
        entityScopes: ["scope_framework"],
      }),
    ).toBe(true);
  });

  it("runs selected scope rules and ignores unrelated non-Global scope rules", () => {
    expect(
      shouldRunAuthoringRuleForEntity({
        ruleScopeId: "scope_framework",
        globalScopeId: "scope_global",
        entityScopes: ["scope_framework"],
      }),
    ).toBe(true);
    expect(
      shouldRunAuthoringRuleForEntity({
        ruleScopeId: "scope_design",
        globalScopeId: "scope_global",
        entityScopes: ["scope_framework"],
      }),
    ).toBe(false);
  });

  it("requires_node_type rules on Global gate by entity membership (not Doco-wide)", () => {
    // A non-Rule entity NOT tagged Global → the Global requires_node_type
    // rule does NOT fire (otherwise it would block every Decision/Action
    // in the Doco).
    expect(
      shouldRunAuthoringRuleForEntity({
        ruleScopeId: "scope_global",
        predicateKind: "requires_node_type",
        globalScopeId: "scope_global",
        entityScopes: ["scope_framework"],
      }),
    ).toBe(false);
    // A non-Rule entity that DOES claim Global → the rule fires (and
    // will reject the entity for being the wrong type).
    expect(
      shouldRunAuthoringRuleForEntity({
        ruleScopeId: "scope_global",
        predicateKind: "requires_node_type",
        globalScopeId: "scope_global",
        entityScopes: ["scope_global"],
      }),
    ).toBe(true);
  });

  it("other Global predicates still fire Doco-wide", () => {
    for (const kind of ["requires_field", "requires_edge", "probabilistic", "mandatory_scope"]) {
      expect(
        shouldRunAuthoringRuleForEntity({
          ruleScopeId: "scope_global",
          predicateKind: kind,
          globalScopeId: "scope_global",
          entityScopes: ["scope_framework"],
        }),
      ).toBe(true);
    }
  });
});

describe("globalScopeMembershipViolation", () => {
  it("rejects non-Rule nodes tagged with Global", () => {
    expect(
      globalScopeMembershipViolation({
        entityNodeType: "decision",
        entityScopes: ["scope_global"],
        globalScopeId: "scope_global",
        globalScopeName: "Global",
      }),
    ).toContain("Only Rule nodes may belong to the Global scope");
  });

  it("allows Rule nodes to belong to Global", () => {
    expect(
      globalScopeMembershipViolation({
        entityNodeType: "rule",
        entityScopes: ["scope_global"],
        globalScopeId: "scope_global",
        globalScopeName: "Global",
      }),
    ).toBeNull();
  });

  it("allows non-Rule nodes when they are not tagged with Global", () => {
    expect(
      globalScopeMembershipViolation({
        entityNodeType: "decision",
        entityScopes: ["scope_framework"],
        globalScopeId: "scope_global",
        globalScopeName: "Global",
      }),
    ).toBeNull();
  });
});
