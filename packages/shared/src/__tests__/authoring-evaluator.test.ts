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
    policy_id: extras.policy_id ?? "node_authoring_policy_test",
    policy: extras.policy ?? "test policy",
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
      P({ kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the required field is missing", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.predicate_kind).toBe("requires_field");
    expect(v[0]?.reason).toMatch(/actor_id/);
  });

  it("treats empty string / empty array as missing", () => {
    const v = evaluate({ id: "action_01", node_type: "action", actor_id: "", intent_ids: [] }, [
      P({
        kind: "requires_field",
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
      P({ kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — forbids_field", () => {
  it("passes when the forbidden field is empty", () => {
    const v = evaluate({ id: "intent_01", node_type: "intent" }, [
      P({ kind: "forbids_field", fields: ["actor_id"], when_node_type: ["intent"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the forbidden field is set", () => {
    const v = evaluate({ id: "intent_01", node_type: "intent", actor_id: "principal_x" }, [
      P({ kind: "forbids_field", fields: ["actor_id"], when_node_type: ["intent"] }),
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
          kind: "unique_field",
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
          kind: "unique_field",
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
    expect(v[0]?.predicate_kind).toBe("unique_field");
    expect(v[0]?.reason).toMatch(/chosen/);
    expect(v[0]?.reason).toMatch(/decision_01/);
  });

  it("does not case-fold unless requested", () => {
    const v = evaluate(
      { id: "decision_02", node_type: "decision", chosen: "Activation Key" },
      [
        P({
          kind: "unique_field",
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
      kind: "unique_field",
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
          kind: "requires_edge",
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
        kind: "requires_edge",
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
          kind: "requires_edge",
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
          kind: "requires_edge_role",
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
          kind: "requires_edge_role",
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
    expect(v[0]?.predicate_kind).toBe("requires_edge_role");
    expect(v[0]?.reason).toMatch(/supports/);
    expect(v[0]?.reason).toMatch(/serves/);
  });
});

describe("authoring evaluator — requires_node_type", () => {
  it("passes when the candidate's node_type is in the allowlist", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ kind: "requires_node_type", node_types: ["action", "intent", "decision"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the candidate's node_type is not in the allowlist", () => {
    const v = evaluate({ id: "log_01", node_type: "log" }, [
      P({ kind: "requires_node_type", node_types: ["action", "intent", "decision"] }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/log/);
  });
});

describe("authoring evaluator — requires_field_resolves_to_principal", () => {
  it("passes when the field resolves to a known Principal id", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action", actor_id: "principal_alice" },
      [
        P({
          kind: "requires_field_resolves_to_principal",
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
          kind: "requires_field_resolves_to_principal",
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
          kind: "requires_field_resolves_to_principal",
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
            kind: "graph-completeness",
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
            kind: "graph-completeness",
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
            kind: "graph-completeness",
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
            kind: "graph-completeness",
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
  it("emits a pending violation with the spec for the LLM judge", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({
        kind: "probabilistic",
        spec: "Action summary reads as an atomic business activity, not an umbrella phase.",
        when_node_type: ["action"],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.predicate_kind).toBe("probabilistic");
    expect(v[0]?.pending_spec).toMatch(/atomic business activity/);
  });
});

describe("authoring evaluator — descriptive", () => {
  it("never produces a violation", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ kind: "descriptive", spec: "Just a note for readers." }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — on_violation propagation", () => {
  it("default on_violation is block", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P({ kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] }),
    ]);
    expect(v[0]?.on_violation).toBe("block");
  });

  it("warn propagates", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [
      P(
        { kind: "requires_field", fields: ["actor_id"], when_node_type: ["action"] },
        { on_violation: "warn" },
      ),
    ]);
    expect(v[0]?.on_violation).toBe("warn");
  });
});
