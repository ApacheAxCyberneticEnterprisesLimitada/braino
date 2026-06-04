import { describe, expect, it } from "vitest";
import {
  type CandidateFields,
  type EngineEdge,
  type LoadedPolicy,
  type PrincipalIndex,
  evaluatePolicies,
} from "../authoring-evaluator.js";

function P(predicate: LoadedPolicy["predicate"], extras: Partial<LoadedPolicy> = {}): LoadedPolicy {
  return {
    policy_id: extras.policy_id ?? "policy_test",
    kind: extras.kind ?? "deterministic",
    predicate,
    ...(extras.on_violation ? { on_violation: extras.on_violation } : {}),
    ...(extras.fires_when_node_lifecycle
      ? { fires_when_node_lifecycle: extras.fires_when_node_lifecycle }
      : {}),
  };
}

function evaluate(
  candidate: CandidateFields,
  policies: LoadedPolicy[],
  extras: {
    candidateEdges?: EngineEdge[];
    edges?: EngineEdge[];
    principals?: PrincipalIndex;
    population?: CandidateFields[];
  } = {},
) {
  return evaluatePolicies({
    candidate,
    policies,
    candidateEdges: extras.candidateEdges ?? [],
    edges: extras.edges ?? [],
    principals: extras.principals ?? new Set(),
    population: extras.population ?? [],
  });
}

describe("authoring evaluator — requires_field", () => {
  it("passes when the required field is populated", () => {
    const v = evaluate({ id: "action_01", node_type: "action", actor_id: "principal_alice" }, [
      P({ sub_kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the required field is missing", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ sub_kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("deterministic");
    expect(v[0]?.sub_kind).toBe("requires_field");
    expect(v[0]?.reason).toMatch(/actor_id/);
  });

  it("treats empty string / empty array as missing", () => {
    const v = evaluate({ id: "action_01", node_type: "action", actor_id: "", intent_ids: [] }, [
      P({
        sub_kind: "requires_field",
        fields: ["actor_id", "intent_ids"],
        when_node_type: ["action"],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/actor_id/);
    expect(v[0]?.reason).toMatch(/intent_ids/);
  });

  it("respects when_node_type — skips non-matching candidates", () => {
    const v = evaluate({ id: "intent_01", node_type: "intent" }, [
      P({ sub_kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — forbids_field", () => {
  it("passes when the forbidden field is empty", () => {
    const v = evaluate({ id: "intent_01", node_type: "intent" }, [
      P({ sub_kind: "forbids_field", fields: ["actor_id"], when_node_type: ["intent"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the forbidden field is set", () => {
    const v = evaluate({ id: "intent_01", node_type: "intent", actor_id: "principal_x" }, [
      P({ sub_kind: "forbids_field", fields: ["actor_id"], when_node_type: ["intent"] }),
    ]);
    expect(v).toHaveLength(1);
  });
});

describe("authoring evaluator — unique_field", () => {
  it("passes when no active node has the same field value", () => {
    const v = evaluate(
      { id: "decision_02", node_type: "decision", chosen: "Activation key" },
      [
        P({
          sub_kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_node_type: ["decision"],
        }),
      ],
      {
        population: [
          { id: "decision_01", node_type: "decision", chosen: "Invite code" },
          { id: "action_01", node_type: "action", chosen: "Activation key" },
        ],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when an active same-type node has the same field value after case folding", () => {
    const v = evaluate(
      { id: "decision_02", node_type: "decision", chosen: "Activation Key" },
      [
        P({
          sub_kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_node_type: ["decision"],
        }),
      ],
      {
        population: [{ id: "decision_01", node_type: "decision", chosen: " activation key " }],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("unique_field");
    expect(v[0]?.reason).toMatch(/chosen/);
    expect(v[0]?.reason).toMatch(/decision_01/);
  });

  it("does not case-fold unless requested", () => {
    const v = evaluate(
      { id: "decision_02", node_type: "decision", chosen: "Activation Key" },
      [
        P({
          sub_kind: "unique_field",
          field: "chosen",
          when_node_type: ["decision"],
        }),
      ],
      {
        population: [{ id: "decision_01", node_type: "decision", chosen: "activation key" }],
      },
    );
    expect(v).toEqual([]);
  });

  it("ignores retired duplicates and empty candidate values", () => {
    const policy = P({
      sub_kind: "unique_field",
      field: "chosen",
      case_fold: true,
      when_node_type: ["decision"],
    });
    expect(
      evaluate({ id: "decision_02", node_type: "decision", chosen: "Activation key" }, [policy], {
        population: [
          {
            id: "decision_01",
            node_type: "decision",
            chosen: "activation key",
            lifecycle: "retired",
          },
        ],
      }),
    ).toEqual([]);
    expect(evaluate({ id: "decision_03", node_type: "decision", chosen: " " }, [policy])).toEqual(
      [],
    );
  });
});

describe("authoring evaluator — requires_edge", () => {
  it("passes when the required outgoing edge is present", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_edge",
          edge_type: "supports",
          target_node_type: "intent",
          when_node_type: ["action"],
        }),
      ],
      {
        candidateEdges: [{ from_id: "action_01", to_id: "intent_42", edge_type: "supports" }],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when the candidate carries no matching outgoing edge", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({
        sub_kind: "requires_edge",
        edge_type: "supports",
        target_node_type: "intent",
        when_node_type: ["action"],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/supports/);
    expect(v[0]?.reason).toMatch(/intent/);
  });

  it("fails when the edge exists but points at the wrong node type", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_edge",
          edge_type: "supports",
          target_node_type: "intent",
          when_node_type: ["action"],
        }),
      ],
      {
        candidateEdges: [{ from_id: "action_01", to_id: "decision_42", edge_type: "supports" }],
      },
    );
    expect(v).toHaveLength(1);
  });
});

describe("authoring evaluator — requires_edge_role", () => {
  it("passes when the required outgoing edge role is present", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_edge_role",
          edge_type: "supports",
          edge_role: "serves",
          target_node_type: "intent",
          when_node_type: ["action"],
        }),
      ],
      {
        candidateEdges: [
          {
            from_id: "action_01",
            to_id: "intent_42",
            edge_type: "supports",
            edge_props_json: { role: "serves" },
          },
        ],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when the edge family matches but role metadata is missing or different", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_edge_role",
          edge_type: "supports",
          edge_role: "serves",
          target_node_type: "intent",
          when_node_type: ["action"],
        }),
      ],
      {
        candidateEdges: [
          {
            from_id: "action_01",
            to_id: "intent_42",
            edge_type: "supports",
            edge_props_json: { role: "implemented_by" },
          },
        ],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_edge_role");
    expect(v[0]?.reason).toMatch(/supports/);
    expect(v[0]?.reason).toMatch(/serves/);
  });
});

describe("authoring evaluator — requires_node_type", () => {
  it("passes when the candidate's node_type is in the allowlist", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ sub_kind: "requires_node_type", node_types: ["action", "intent", "decision"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the candidate's node_type is not in the allowlist", () => {
    const v = evaluate({ id: "log_01", node_type: "log" }, [
      P({ sub_kind: "requires_node_type", node_types: ["action", "intent", "decision"] }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/log/);
  });

  it("treats Doco policy records as metadata outside template node allowlists", () => {
    const membershipPolicy = P({
      sub_kind: "requires_node_type",
      node_types: ["intent", "decision", "principal"],
    });
    const policyCandidate: CandidateFields = { id: "policy_01" };
    expect(evaluate(policyCandidate, [membershipPolicy])).toEqual([]);
  });
});

describe("authoring evaluator — requires_entity_type", () => {
  const membershipPolicy = P({
    sub_kind: "requires_entity_type",
    entity_types: ["intent", "decision", "principal"],
  });

  it("passes when the candidate id prefix is in the allowlist", () => {
    const v = evaluate({ id: "decision_01", node_type: "decision" }, [membershipPolicy]);
    expect(v).toEqual([]);
  });

  it("fails when the candidate id prefix is not in the allowlist", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [membershipPolicy]);
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_entity_type");
    expect(v[0]?.reason).toMatch(/action/);
  });

  it("treats Doco policy records as metadata outside template membership allowlists", () => {
    const policyCandidate: CandidateFields = { id: "policy_01" };
    expect(evaluate(policyCandidate, [membershipPolicy])).toEqual([]);
  });
});

describe("authoring evaluator — requires_field_resolves_to_principal", () => {
  it("passes when the field resolves to a known Principal id", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action", actor_id: "principal_alice" },
      [
        P({
          sub_kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_node_type: ["action"],
        }),
      ],
      { principals: new Set(["principal_alice"]) },
    );
    expect(v).toEqual([]);
  });

  it("fails when the field is empty", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_node_type: ["action"],
        }),
      ],
      { principals: new Set(["principal_alice"]) },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/empty/);
  });

  it("fails when the field references an unknown id (the BPM bug)", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action", actor_id: "principal_ghost" },
      [
        P({
          sub_kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_node_type: ["action"],
        }),
      ],
      { principals: new Set(["principal_alice"]) },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/principal_ghost/);
    expect(v[0]?.reason).toMatch(/does not resolve/);
  });
});

describe("authoring evaluator — graph-completeness", () => {
  it("passes when every actor on the Intent has an Action covering it", () => {
    const v = evaluate(
      {
        id: "intent_01",
        node_type: "intent",
        actors: ["principal_alice", "principal_bob"],
        lifecycle: "accepted",
      },
      [
        P(
          {
            sub_kind: "graph-completeness",
            list_field: "actors",
            edge_type: "supports",
            incoming_node_type: "action",
            incoming_field_must_match: "actor_id",
            when_node_type: ["intent"],
          },
          { fires_when_node_lifecycle: ["accepted"] },
        ),
      ],
      {
        population: [
          { id: "action_01", node_type: "action", actor_id: "principal_alice" },
          { id: "action_02", node_type: "action", actor_id: "principal_bob" },
        ],
        edges: [
          { from_id: "action_01", to_id: "intent_01", edge_type: "supports" },
          { from_id: "action_02", to_id: "intent_01", edge_type: "supports" },
        ],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when an actor on the Intent has no matching Action serving it", () => {
    const v = evaluate(
      {
        id: "intent_01",
        node_type: "intent",
        actors: ["principal_alice", "principal_bob"],
        lifecycle: "accepted",
      },
      [
        P(
          {
            sub_kind: "graph-completeness",
            list_field: "actors",
            edge_type: "supports",
            incoming_node_type: "action",
            incoming_field_must_match: "actor_id",
            when_node_type: ["intent"],
          },
          { fires_when_node_lifecycle: ["accepted"] },
        ),
      ],
      {
        population: [
          { id: "action_01", node_type: "action", actor_id: "principal_alice" },
          // No Action for principal_bob.
        ],
        edges: [{ from_id: "action_01", to_id: "intent_01", edge_type: "supports" }],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/principal_bob/);
  });

  it("fails when the matching Action exists but lacks the supports edge", () => {
    const v = evaluate(
      { id: "intent_01", node_type: "intent", actors: ["principal_alice"], lifecycle: "accepted" },
      [
        P(
          {
            sub_kind: "graph-completeness",
            list_field: "actors",
            edge_type: "supports",
            incoming_node_type: "action",
            incoming_field_must_match: "actor_id",
            when_node_type: ["intent"],
          },
          { fires_when_node_lifecycle: ["accepted"] },
        ),
      ],
      {
        population: [{ id: "action_01", node_type: "action", actor_id: "principal_alice" }],
        edges: [], // No edge → Intent.
      },
    );
    expect(v).toHaveLength(1);
  });

  it("does not fire on drafting Intents (lifecycle filter)", () => {
    const v = evaluate(
      {
        id: "intent_01",
        node_type: "intent",
        actors: ["principal_alice"],
        lifecycle: "drafting",
      },
      [
        P(
          {
            sub_kind: "graph-completeness",
            list_field: "actors",
            edge_type: "supports",
            incoming_node_type: "action",
            incoming_field_must_match: "actor_id",
            when_node_type: ["intent"],
          },
          { fires_when_node_lifecycle: ["accepted"] },
        ),
      ],
    );
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — probabilistic", () => {
  it("emits a pending violation with the agent instruction for the LLM judge", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P(
        {
          agent_instruction:
            "Action summary reads as an atomic business activity, not an umbrella phase.",
          when_node_type: ["action"],
        },
        { kind: "probabilistic" },
      ),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("probabilistic");
    expect(v[0]?.pending_spec).toMatch(/atomic business activity/);
  });

  it("respects when_node_type for probabilistic policies", () => {
    const v = evaluate({ id: "intent_01", node_type: "intent" }, [
      P(
        { agent_instruction: "judge the action", when_node_type: ["action"] },
        { kind: "probabilistic" },
      ),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — suggestion", () => {
  it("never produces a violation", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ agent_instruction: "Just a note for readers." }, { kind: "suggestion" }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — on_violation propagation", () => {
  it("default on_violation is block", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ sub_kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v[0]?.on_violation).toBe("block");
  });

  it("warn propagates", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P(
        { sub_kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] },
        { on_violation: "warn" },
      ),
    ]);
    expect(v[0]?.on_violation).toBe("warn");
  });
});

// ─── new deterministic checks ────────────────────────────────────────────────

describe("authoring evaluator — requires_edge min_count", () => {
  const gatewayRule = () =>
    P({
      sub_kind: "requires_edge",
      edge_type: "flows_to",
      min_count: 2,
      when_node_type: ["decision"],
    });
  const out = (from: string, to: string) => ({ from_id: from, to_id: to, edge_type: "flows_to" });

  it("passes when at least min_count outgoing edges are present", () => {
    const v = evaluate({ id: "decision_01", node_type: "decision" }, [gatewayRule()], {
      candidateEdges: [out("decision_01", "state_a"), out("decision_01", "state_b")],
    });
    expect(v).toEqual([]);
  });

  it("fails when fewer than min_count outgoing edges are present", () => {
    const v = evaluate({ id: "decision_01", node_type: "decision" }, [gatewayRule()], {
      candidateEdges: [out("decision_01", "state_a")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_edge");
    expect(v[0]?.reason).toMatch(/2/);
  });
});

describe("authoring evaluator — requires_edge_role direction + exemption", () => {
  const coverage = () =>
    P({
      sub_kind: "requires_edge_role",
      edge_type: "attributed_to",
      edge_role: "performed_by",
      direction: "incoming",
      exempt_when_role: "owned_by",
      when_node_type: ["principal"],
    });
  const inEdge = (from: string, role: string) => ({
    from_id: from,
    to_id: "principal_01",
    edge_type: "attributed_to",
    edge_props_json: { role },
  });

  it("passes when an incoming performed_by edge points at the principal", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      edges: [inEdge("action_a", "performed_by")],
    });
    expect(v).toEqual([]);
  });

  it("fails when no incoming performed_by edge exists", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      edges: [inEdge("action_a", "decided_by")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_edge_role");
    expect(v[0]?.reason).toMatch(/incoming/);
  });

  it("is exempt when the principal carries the exemption role (owned_by owner)", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      edges: [inEdge("intent_a", "owned_by")],
    });
    expect(v).toEqual([]);
  });

  it("does not count an OUTGOING performed_by as satisfying an incoming requirement", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      candidateEdges: [
        {
          from_id: "principal_01",
          to_id: "action_a",
          edge_type: "attributed_to",
          edge_props_json: { role: "performed_by" },
        },
      ],
    });
    expect(v).toHaveLength(1);
  });
});

describe("authoring evaluator — forbids_field_pattern", () => {
  const scaffolding = () =>
    P({
      sub_kind: "forbids_field_pattern",
      fields: ["action", "decision"],
      pattern: "(exclusiveGateway|Gateway_[A-Za-z0-9]+|user asks:)",
      flags: "i",
      when_node_type: ["action", "decision"],
    });

  it("passes on clean business prose", () => {
    const v = evaluate({ id: "action_01", node_type: "action", action: "approve the invoice" }, [
      scaffolding(),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when a field contains a raw BPMN/import token", () => {
    const v = evaluate(
      { id: "decision_01", node_type: "decision", decision: "route via Gateway_0x1f manually" },
      [scaffolding()],
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("forbids_field_pattern");
    expect(v[0]?.reason).toMatch(/decision/);
  });

  it("does not crash on a malformed regex — fails open (no violation)", () => {
    const v = evaluate({ id: "action_01", node_type: "action", action: "anything" }, [
      P({ sub_kind: "forbids_field_pattern", fields: ["action"], pattern: "(unclosed" }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — flow-wiring", () => {
  const wiring = () =>
    P({
      sub_kind: "flow-wiring",
      edge_type: "flows_to",
      initial_when: { field: "kind", equals: "initial" },
      terminal_when: { field: "kind", equals: "terminal" },
      when_node_type: ["action", "decision", "state"],
    });
  const flow = (from: string, to: string) => ({ from_id: from, to_id: to, edge_type: "flows_to" });

  it("passes an intermediate node with both an incoming and an outgoing flow", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [wiring()], {
      candidateEdges: [flow("action_01", "state_end")],
      edges: [flow("state_start", "action_01"), flow("action_01", "state_end")],
    });
    expect(v).toEqual([]);
  });

  it("fails an intermediate node missing an incoming flow (unreachable)", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [wiring()], {
      candidateEdges: [flow("action_01", "state_end")],
      edges: [flow("action_01", "state_end")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("flow-wiring");
    expect(v[0]?.reason).toMatch(/incoming|unreachable/i);
  });

  it("fails an intermediate node missing an outgoing flow (dead end)", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [wiring()], {
      edges: [flow("state_start", "action_01")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/outgoing|dead end/i);
  });

  it("exempts an initial State from the incoming requirement", () => {
    const v = evaluate({ id: "state_01", node_type: "state", kind: "initial" }, [wiring()], {
      candidateEdges: [flow("state_01", "action_a")],
      edges: [flow("state_01", "action_a")],
    });
    expect(v).toEqual([]);
  });

  it("requires an initial State to still have an outgoing flow", () => {
    const v = evaluate({ id: "state_01", node_type: "state", kind: "initial" }, [wiring()], {
      edges: [],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/outgoing|dead end/i);
  });

  it("passes a terminal State with an incoming flow and no outgoing", () => {
    const v = evaluate({ id: "state_99", node_type: "state", kind: "terminal" }, [wiring()], {
      edges: [flow("decision_a", "state_99")],
    });
    expect(v).toEqual([]);
  });

  it("fails a terminal State that carries an outgoing flow", () => {
    const v = evaluate({ id: "state_99", node_type: "state", kind: "terminal" }, [wiring()], {
      candidateEdges: [flow("state_99", "state_other")],
      edges: [flow("decision_a", "state_99"), flow("state_99", "state_other")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/terminal/i);
  });

  it("fails a terminal State with no incoming flow (unreachable end)", () => {
    const v = evaluate({ id: "state_99", node_type: "state", kind: "terminal" }, [wiring()], {
      edges: [],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/incoming|unreachable/i);
  });
});
