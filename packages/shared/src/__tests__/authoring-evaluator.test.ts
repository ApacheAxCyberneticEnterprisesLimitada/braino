import { describe, expect, it } from "vitest";
import {
  type CandidateFields,
  type EdgeCandidate,
  type EngineEdge,
  type LoadedPolicy,
  type PrincipalIndex,
  evaluateEdgePolicies,
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

describe("authoring evaluator — requires_edge distinguishes by endpoint type", () => {
  // With `role` gone, the meaning that used to live on a role tag (e.g. an
  // Action's `attributed_to` performer vs an Intent's `attributed_to` owner)
  // is now carried entirely by `edge_type` + `target_node_type`. The performer
  // gate is `attributed_to` → principal from an Action.
  it("passes when the required edge points at the right endpoint type", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["action"],
        }),
      ],
      {
        candidateEdges: [
          { from_id: "action_01", to_id: "principal_42", edge_type: "attributed_to" },
        ],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when the edge family matches but the endpoint type is wrong", () => {
    const v = evaluate(
      { id: "action_01", node_type: "action" },
      [
        P({
          sub_kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["action"],
        }),
      ],
      {
        candidateEdges: [
          // An `attributed_to` edge to the wrong endpoint type doesn't satisfy
          // the performer gate (what used to be the wrong-role case).
          { from_id: "action_01", to_id: "decision_42", edge_type: "attributed_to" },
        ],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_edge");
    expect(v[0]?.reason).toMatch(/attributed_to/);
    expect(v[0]?.reason).toMatch(/principal/);
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

describe("authoring evaluator — requires_edge_type (edge-type allowlist)", () => {
  // The edge analogue of requires_node_type: a Doco-wide deterministic gate
  // enforced on edge CREATION via evaluateEdgePolicies. An edge whose type isn't
  // in the allowlist is rejected.
  const allowlist = (extras: Partial<LoadedPolicy> = {}) =>
    P({ sub_kind: "requires_edge_type", edge_types: ["flows_to", "supports"] }, extras);

  it("passes an edge whose type is in the allowlist", () => {
    const v = evaluateEdgePolicies({ edge: { edge_type: "supports" }, policies: [allowlist()] });
    expect(v).toEqual([]);
  });

  it("blocks an edge whose type is not in the allowlist", () => {
    const v = evaluateEdgePolicies({ edge: { edge_type: "has_parent" }, policies: [allowlist()] });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("deterministic");
    expect(v[0]?.sub_kind).toBe("requires_edge_type");
    expect(v[0]?.on_violation).toBe("block");
    expect(v[0]?.reason).toMatch(/has_parent/);
  });

  it("fires even when probabilistic checks are skipped (a drafting edge)", () => {
    // The allowlist is a structural membership gate, so it applies even to a
    // `drafting` edge (includeProbabilistic=false), unlike the quality judges.
    const v = evaluateEdgePolicies({
      edge: { edge_type: "has_parent" },
      policies: [allowlist()],
      includeProbabilistic: false,
    });
    expect(v.some((x) => x.sub_kind === "requires_edge_type")).toBe(true);
  });

  it("honors on_violation: warn", () => {
    const v = evaluateEdgePolicies({
      edge: { edge_type: "has_parent" },
      policies: [allowlist({ on_violation: "warn" })],
    });
    expect(v[0]?.on_violation).toBe("warn");
  });

  it("does not constrain node candidates (edge-scoped only)", () => {
    // On the node path it's a no-op — a node never trips the edge-type allowlist.
    const v = evaluate({ id: "action_01", node_type: "action" }, [allowlist()]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — edge-scoped probabilistic", () => {
  const edgePolicy = (extras: Partial<LoadedPolicy> = {}) =>
    P(
      {
        agent_instruction: "Intent name is the base form of the Action it serves.",
        edge_type: "supports",
        from_node_type: "action",
        to_node_type: "intent",
      },
      { kind: "probabilistic", ...extras },
    );

  const edge: EdgeCandidate = {
    edge_type: "supports",
    from_node_type: "action",
    to_node_type: "intent",
  };

  it("node evaluation IGNORES an edge-scoped predicate (it never fires on a node)", () => {
    // Even with a matching node_type-less probabilistic policy, the node
    // evaluator must skip edge predicates — they belong to the edge evaluator.
    const v = evaluate({ id: "intent_01", node_type: "intent" }, [edgePolicy()]);
    expect(v).toEqual([]);
  });

  it("emits a pending probabilistic violation when the edge matches", () => {
    const v = evaluateEdgePolicies({ edge, policies: [edgePolicy()] });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("probabilistic");
    expect(v[0]?.on_violation).toBe("block");
    expect(v[0]?.pending_spec).toMatch(/base form of the Action/);
  });

  it("does not fire when the edge_type differs", () => {
    expect(
      evaluateEdgePolicies({ edge: { ...edge, edge_type: "flows_to" }, policies: [edgePolicy()] }),
    ).toEqual([]);
  });

  it("does not fire when the `to` endpoint node type differs (action supports rule)", () => {
    // With `role` gone, endpoint node types are the only scoping left beyond
    // edge_type — a `supports` edge to a non-Intent doesn't match the policy.
    expect(
      evaluateEdgePolicies({ edge: { ...edge, to_node_type: "rule" }, policies: [edgePolicy()] }),
    ).toEqual([]);
  });

  it("does not fire when an endpoint node type differs (decision serves intent)", () => {
    expect(
      evaluateEdgePolicies({
        edge: { ...edge, from_node_type: "decision" },
        policies: [edgePolicy()],
      }),
    ).toEqual([]);
  });

  it("ignores deterministic and node-scoped probabilistic policies", () => {
    const nodeProb = P(
      { agent_instruction: "judge the intent", when_node_type: ["intent"] },
      { kind: "probabilistic" },
    );
    const deterministic = P({
      sub_kind: "requires_field",
      fields: ["intent"],
      when_node_type: ["intent"],
    });
    expect(evaluateEdgePolicies({ edge, policies: [nodeProb, deterministic] })).toEqual([]);
  });

  it("honors on_violation = warn on the edge policy", () => {
    const v = evaluateEdgePolicies({ edge, policies: [edgePolicy({ on_violation: "warn" })] });
    expect(v[0]?.on_violation).toBe("warn");
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

describe("authoring evaluator — limits_edge", () => {
  // The ceiling counterpart to requires_edge: a candidate may carry AT MOST
  // max_count (default 1) edges of (edge_type[, target_node_type]). With `role`
  // gone, the business-processes "a flow node serves exactly one Intent" gate is
  // `limits_edge`(supports → intent), paired with the requires_edge serves floor.
  const servesAtMostOne = () =>
    P({
      sub_kind: "limits_edge",
      edge_type: "supports",
      target_node_type: "intent",
      when_node_type: ["action", "decision", "state"],
    });
  const supports = (from: string, to: string) => ({
    from_id: from,
    to_id: to,
    edge_type: "supports",
  });

  it("passes when the candidate serves exactly one Intent", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [servesAtMostOne()], {
      candidateEdges: [supports("action_01", "intent_01")],
    });
    expect(v).toEqual([]);
  });

  it("passes when the candidate serves no Intent (the floor gate owns the ≥1 rule)", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [servesAtMostOne()], {
      candidateEdges: [],
    });
    expect(v).toEqual([]);
  });

  it("fails when the candidate serves two Intents", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [servesAtMostOne()], {
      candidateEdges: [supports("action_01", "intent_01"), supports("action_01", "intent_02")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("deterministic");
    expect(v[0]?.sub_kind).toBe("limits_edge");
    expect(v[0]?.reason).toMatch(/supports/);
    expect(v[0]?.reason).toMatch(/max 1/);
  });

  it("counts only matching edge_type + target — other supports edges don't push it over", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [servesAtMostOne()], {
      candidateEdges: [
        supports("action_01", "intent_01"),
        // a `supports` edge to a non-Intent target does not count toward the cap
        supports("action_01", "decision_09"),
        // a non-`supports` edge to an Intent does not count either
        { from_id: "action_01", to_id: "intent_02", edge_type: "attributed_to" },
      ],
    });
    expect(v).toEqual([]);
  });

  it("honors max_count > 1", () => {
    const v = evaluate(
      { id: "intent_01", node_type: "intent" },
      [
        P({
          sub_kind: "limits_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          max_count: 2,
          when_node_type: ["intent"],
        }),
      ],
      {
        candidateEdges: [
          { from_id: "intent_01", to_id: "principal_a", edge_type: "attributed_to" },
          { from_id: "intent_01", to_id: "principal_b", edge_type: "attributed_to" },
          { from_id: "intent_01", to_id: "principal_c", edge_type: "attributed_to" },
        ],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/max 2/);
  });
});

describe("authoring evaluator — requires_edge direction + exemption", () => {
  // With `role` gone, the per-step actor-coverage gate becomes
  // requires_edge(attributed_to, direction: incoming, target_node_type: action)
  // on a Principal: it must be the target of an incoming `attributed_to` edge
  // FROM an Action, unless it is exempt because it owns an Intent (the
  // accountable process owner, whose `attributed_to` comes from an Intent).
  const coverage = () =>
    P({
      sub_kind: "requires_edge",
      edge_type: "attributed_to",
      direction: "incoming",
      target_node_type: "action",
      exempt_when_other_node_type: "intent",
      when_node_type: ["principal"],
    });
  const inEdge = (from: string) => ({
    from_id: from,
    to_id: "principal_01",
    edge_type: "attributed_to",
  });

  it("passes when an incoming attributed_to edge from an Action points at the principal", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      edges: [inEdge("action_a")],
    });
    expect(v).toEqual([]);
  });

  it("fails when no incoming attributed_to edge from an Action exists", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      edges: [inEdge("decision_a")],
    });
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_edge");
    expect(v[0]?.reason).toMatch(/incoming/);
  });

  it("is exempt when the principal owns an Intent (incoming attributed_to from an Intent)", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      edges: [inEdge("intent_a")],
    });
    expect(v).toEqual([]);
  });

  it("does not count an OUTGOING attributed_to as satisfying an incoming requirement", () => {
    const v = evaluate({ id: "principal_01", node_type: "principal" }, [coverage()], {
      candidateEdges: [{ from_id: "principal_01", to_id: "action_a", edge_type: "attributed_to" }],
    });
    expect(v).toHaveLength(1);
  });
});

describe("authoring evaluator — requires_edge exempt_when_field_truthy", () => {
  // A field-based escape hatch (distinct from the structural edge exemptions): a
  // candidate carrying a truthy value at the named field is excused from the
  // floor. The process-membership floor uses it so an Action catalogued as an
  // entry point (an `entry_point` flag in its `extra`, surfaced flat on the
  // candidate) needs no `has_parent` parent process.
  const membershipFloor = () =>
    P({
      sub_kind: "requires_edge",
      edge_type: "has_parent",
      target_node_type: "action",
      exempt_when_field_truthy: "entry_point",
      when_node_type: ["action", "decision", "state"],
    });

  it("fails an Action with no parent and no entry_point flag", () => {
    const v = evaluate({ id: "action_01", node_type: "action" }, [membershipFloor()]);
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_edge");
    expect(v[0]?.reason).toMatch(/has_parent/);
  });

  it("exempts an Action explicitly catalogued as an entry point", () => {
    const v = evaluate({ id: "action_01", node_type: "action", entry_point: true }, [
      membershipFloor(),
    ]);
    expect(v).toEqual([]);
  });

  it("does not exempt when the flag is falsy", () => {
    const v = evaluate({ id: "action_01", node_type: "action", entry_point: false }, [
      membershipFloor(),
    ]);
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
