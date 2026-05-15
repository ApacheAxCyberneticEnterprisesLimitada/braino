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
