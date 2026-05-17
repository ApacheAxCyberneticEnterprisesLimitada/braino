import { describe, expect, it } from "vitest";
import type { Entity } from "../entities.js";
import {
  evaluateScopeRules,
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
    // A node NOT tagged Global → the Global requires_node_type
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
    // A node that DOES claim Global → the rule fires (and can reject the
    // entity for being the wrong type).
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
  it("rejects nodes other than Intent or Rule tagged with Global", () => {
    expect(
      globalScopeMembershipViolation({
        entityNodeType: "decision",
        entityScopes: ["scope_global"],
        globalScopeId: "scope_global",
        globalScopeName: "Global",
      }),
    ).toContain("Only Intent and Rule nodes may belong to the Global scope");
  });

  it("allows Intent and Rule nodes to belong to Global", () => {
    expect(
      globalScopeMembershipViolation({
        entityNodeType: "intent",
        entityScopes: ["scope_global"],
        globalScopeId: "scope_global",
        globalScopeName: "Global",
      }),
    ).toBeNull();
    expect(
      globalScopeMembershipViolation({
        entityNodeType: "rule",
        entityScopes: ["scope_global"],
        globalScopeId: "scope_global",
        globalScopeName: "Global",
      }),
    ).toBeNull();
  });

  it("allows other nodes when they are not tagged with Global", () => {
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

  it("allows Intent nodes tagged with Global without a seeded Global authoring rule", () => {
    const violations = hardWrittenDocoRuleViolations({
      entity: entity({
        id: "intent_1",
        node_type: "intent",
        scopes: ["scope_global"],
      }),
      globalScopeId: "scope_global",
      globalScopeName: "Global",
    });

    expect(violations).toEqual([]);
  });

  it("rejects other nodes tagged with Global without a seeded Global authoring rule", () => {
    const violations = hardWrittenDocoRuleViolations({
      entity: entity({
        id: "decision_1",
        node_type: "decision",
        scopes: ["scope_global"],
        alternatives: [{ name: "Use framework default", rejected_because: "Global is reserved." }],
      }),
      globalScopeId: "scope_global",
      globalScopeName: "Global",
    });

    expect(violations).toHaveLength(1);
    expect(violations[0].rule_id).toBe("framework:global-scope-intent-rule-only");
    expect(violations[0].reason).toContain("Only Intent and Rule nodes may belong to the Global scope");
  });
});

describe("graph-completeness predicate", () => {
  const userFlowsScope = "scope_uf";
  const intentId = "intent_journey1";
  const visitorId = "principal_visitor";
  const adminId = "principal_admin";

  // No `reason` override — we want the auto-generated text so the
  // tests can assert the violation names the missing principal.
  const completenessRule = {
    rule_id: "rule_actors_completeness",
    scope_id: userFlowsScope,
    predicate: {
      kind: "graph-completeness" as const,
      scope_ref: "$capture_scope",
      list_field: "actors",
      edge_type: "serves",
      incoming_node_type: "action" as const,
      incoming_field_must_match: "actor_id",
      when_node_type: ["intent" as const],
    },
  };

  it("passes when every actor on the Intent has at least one Action serving the Intent", () => {
    const candidate = entity({
      id: intentId,
      node_type: "intent",
      lifecycle: "active",
      scopes: [userFlowsScope],
      actors: [visitorId, adminId],
    });
    const actionA = entity({
      id: "action_a",
      node_type: "action",
      lifecycle: "active",
      scopes: [userFlowsScope],
      actor_id: visitorId,
    });
    const actionB = entity({
      id: "action_b",
      node_type: "action",
      lifecycle: "active",
      scopes: [userFlowsScope],
      actor_id: adminId,
    });
    const violations = evaluateScopeRules({
      entity: candidate,
      authoring_rules: [completenessRule],
      scopeName: "user-flows",
      allEdges: [
        { from_id: "action_a", to_id: intentId, edge_type: "serves" },
        { from_id: "action_b", to_id: intentId, edge_type: "serves" },
      ],
      entityScopes: [userFlowsScope],
      nodesByScope: new Map([[userFlowsScope, [candidate, actionA, actionB]]]),
    });
    expect(violations).toEqual([]);
  });

  it("rejects an Intent whose actor has no serving Action with matching actor_id", () => {
    const candidate = entity({
      id: intentId,
      node_type: "intent",
      lifecycle: "active",
      scopes: [userFlowsScope],
      actors: [visitorId, adminId],
    });
    // Only visitor has an Action; admin is missing.
    const actionA = entity({
      id: "action_a",
      node_type: "action",
      lifecycle: "active",
      scopes: [userFlowsScope],
      actor_id: visitorId,
    });
    const violations = evaluateScopeRules({
      entity: candidate,
      authoring_rules: [completenessRule],
      scopeName: "user-flows",
      allEdges: [{ from_id: "action_a", to_id: intentId, edge_type: "serves" }],
      entityScopes: [userFlowsScope],
      nodesByScope: new Map([[userFlowsScope, [candidate, actionA]]]),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("error");
    expect(violations[0].reason).toContain(adminId);
  });

  it("is a no-op when the Intent has no actors yet (drafting an empty journey)", () => {
    const candidate = entity({
      id: intentId,
      node_type: "intent",
      lifecycle: "active",
      scopes: [userFlowsScope],
    });
    const violations = evaluateScopeRules({
      entity: candidate,
      authoring_rules: [completenessRule],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
      nodesByScope: new Map([[userFlowsScope, [candidate]]]),
    });
    expect(violations).toEqual([]);
  });

  it("skips evaluation when fires_when_node_lifecycle excludes the candidate", () => {
    const candidate = entity({
      id: intentId,
      node_type: "intent",
      lifecycle: "drafted",
      scopes: [userFlowsScope],
      actors: [visitorId, adminId],
    });
    const violations = evaluateScopeRules({
      entity: candidate,
      authoring_rules: [{ ...completenessRule, fires_when_node_lifecycle: ["active"] }],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
      nodesByScope: new Map([[userFlowsScope, [candidate]]]),
    });
    expect(violations).toEqual([]);
  });
});

describe("requires_field_resolves_to_principal predicate", () => {
  const userFlowsScope = "scope_uf";
  const personId = "principal_alice";
  const agentId = "principal_bot";
  const orgId = "principal_acme";

  // No `reason` override — we want the auto-generated text so the
  // tests can assert the violation names the offending principal/type.
  const actorTypeRule = {
    rule_id: "rule_actor_principal_type",
    scope_id: userFlowsScope,
    predicate: {
      kind: "requires_field_resolves_to_principal" as const,
      field: "actor_id",
      allowed_principal_types: ["human" as const, "agent" as const],
      when_node_type: ["action" as const],
    },
  };

  const principalIndex = new Map<string, { type: string }>([
    [personId, { type: "human" }],
    [agentId, { type: "agent" }],
    [orgId, { type: "organization" }],
  ]);

  it("passes when actor_id resolves to a human Principal", () => {
    const violations = evaluateScopeRules({
      entity: entity({
        id: "action_1",
        node_type: "action",
        scopes: [userFlowsScope],
        actor_id: personId,
      }),
      authoring_rules: [actorTypeRule],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
      principalIndex,
    });
    expect(violations).toEqual([]);
  });

  it("rejects actor_id that points at a Principal of the wrong type", () => {
    const violations = evaluateScopeRules({
      entity: entity({
        id: "action_1",
        node_type: "action",
        scopes: [userFlowsScope],
        actor_id: orgId,
      }),
      authoring_rules: [actorTypeRule],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
      principalIndex,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("error");
    expect(violations[0].reason).toContain("organization");
  });

  it("rejects actor_id that doesn't resolve to any Principal", () => {
    const violations = evaluateScopeRules({
      entity: entity({
        id: "action_1",
        node_type: "action",
        scopes: [userFlowsScope],
        actor_id: "principal_ghost",
      }),
      authoring_rules: [actorTypeRule],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
      principalIndex,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("principal_ghost");
  });

  it("is a no-op when actor_id is missing (other rule catches the missing field)", () => {
    const violations = evaluateScopeRules({
      entity: entity({
        id: "action_1",
        node_type: "action",
        scopes: [userFlowsScope],
      }),
      authoring_rules: [actorTypeRule],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
      principalIndex,
    });
    expect(violations).toEqual([]);
  });

  it("emits a loud error when no principalIndex was supplied", () => {
    const violations = evaluateScopeRules({
      entity: entity({
        id: "action_1",
        node_type: "action",
        scopes: [userFlowsScope],
        actor_id: personId,
      }),
      authoring_rules: [actorTypeRule],
      scopeName: "user-flows",
      allEdges: [],
      entityScopes: [userFlowsScope],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toContain("principal index");
  });
});
