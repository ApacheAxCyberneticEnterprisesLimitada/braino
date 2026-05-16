import { describe, expect, it } from "vitest";
import type { Entity } from "../entities.js";
import {
  globalScopeMembershipViolation,
  hardWrittenDocoRuleViolations,
  shouldRunAuthoringRuleForEntity,
} from "../scope-rules.js";

const entity = (fm: Record<string, unknown>) => fm as unknown as Entity;

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

describe("hardWrittenDocoRuleViolations", () => {
  it("rejects Decisions without alternatives even when no authoring rules are loaded", () => {
    const violations = hardWrittenDocoRuleViolations({
      entity: entity({
        id: "decision_1",
        node_type: "decision",
        scopes: ["scope_framework"],
      }),
      globalScopeId: "scope_global",
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].rule_id).toBe("framework:decision-alternatives-required");
    expect(violations[0].reason).toContain("Every Decision must populate `alternatives`");
  });

  it("allows Decisions with populated alternatives", () => {
    const violations = hardWrittenDocoRuleViolations({
      entity: entity({
        id: "decision_1",
        node_type: "decision",
        scopes: ["scope_framework"],
        alternatives: [{ name: "Wait", rejected_because: "The invariant should hold now." }],
      }),
      globalScopeId: "scope_global",
    });

    expect(violations).toEqual([]);
  });

  it("rejects non-Rule nodes tagged with Global without a seeded Global authoring rule", () => {
    const violations = hardWrittenDocoRuleViolations({
      entity: entity({
        id: "intent_1",
        node_type: "intent",
        scopes: ["scope_global"],
      }),
      globalScopeId: "scope_global",
      globalScopeName: "Global",
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].rule_id).toBe("framework:global-scope-rule-only");
    expect(violations[0].reason).toContain("Only Rule nodes may belong to the Global scope");
  });
});
