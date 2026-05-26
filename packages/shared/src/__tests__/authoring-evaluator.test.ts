import { describe, expect, it } from "vitest";
import {
  type CandidateFields,
  type EngineSynapse,
  type LoadedPolicy,
  type PrincipalIndex,
  evaluatePolicies,
} from "../authoring-evaluator.js";

function P(predicate: LoadedPolicy["predicate"], extras: Partial<LoadedPolicy> = {}): LoadedPolicy {
  return {
    policy_id: extras.policy_id ?? "neuron_authoring_policy_test",
    policy: extras.policy ?? "test policy",
    predicate,
    ...(extras.on_violation ? { on_violation: extras.on_violation } : {}),
    ...(extras.fires_when_neuron_lifecycle
      ? { fires_when_neuron_lifecycle: extras.fires_when_neuron_lifecycle }
      : {}),
  };
}

function evaluate(
  candidate: CandidateFields,
  policies: LoadedPolicy[],
  extras: {
    candidateSynapses?: EngineSynapse[];
    synapses?: EngineSynapse[];
    principals?: PrincipalIndex;
    population?: CandidateFields[];
  } = {},
) {
  return evaluatePolicies({
    candidate,
    policies,
    candidateSynapses: extras.candidateSynapses ?? [],
    synapses: extras.synapses ?? [],
    principals: extras.principals ?? new Set(),
    population: extras.population ?? [],
  });
}

describe("authoring evaluator — requires_field", () => {
  it("passes when the required field is populated", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action", actor_id: "principal_alice" }, [
      P({ kind: "requires_field", fields: ["actor_id"], when_neuron_type: ["action"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the required field is missing", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P({ kind: "requires_field", fields: ["actor_id"], when_neuron_type: ["action"] }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.predicate_kind).toBe("requires_field");
    expect(v[0]?.reason).toMatch(/actor_id/);
  });

  it("treats empty string / empty array as missing", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action", actor_id: "", intent_ids: [] }, [
      P({
        kind: "requires_field",
        fields: ["actor_id", "intent_ids"],
        when_neuron_type: ["action"],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/actor_id/);
    expect(v[0]?.reason).toMatch(/intent_ids/);
  });

  it("respects when_neuron_type — skips non-matching candidates", () => {
    const v = evaluate({ id: "intent_01", neuron_type: "intent" }, [
      P({ kind: "requires_field", fields: ["actor_id"], when_neuron_type: ["action"] }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — forbids_field", () => {
  it("passes when the forbidden field is empty", () => {
    const v = evaluate({ id: "intent_01", neuron_type: "intent" }, [
      P({ kind: "forbids_field", fields: ["actor_id"], when_neuron_type: ["intent"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the forbidden field is set", () => {
    const v = evaluate({ id: "intent_01", neuron_type: "intent", actor_id: "principal_x" }, [
      P({ kind: "forbids_field", fields: ["actor_id"], when_neuron_type: ["intent"] }),
    ]);
    expect(v).toHaveLength(1);
  });
});

describe("authoring evaluator — unique_field", () => {
  it("passes when no active neuron has the same field value", () => {
    const v = evaluate(
      { id: "decision_02", neuron_type: "decision", chosen: "Activation key" },
      [
        P({
          kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_neuron_type: ["decision"],
        }),
      ],
      {
        population: [
          { id: "decision_01", neuron_type: "decision", chosen: "Invite code" },
          { id: "action_01", neuron_type: "action", chosen: "Activation key" },
        ],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when an active same-type neuron has the same field value after case folding", () => {
    const v = evaluate(
      { id: "decision_02", neuron_type: "decision", chosen: "Activation Key" },
      [
        P({
          kind: "unique_field",
          field: "chosen",
          case_fold: true,
          when_neuron_type: ["decision"],
        }),
      ],
      {
        population: [{ id: "decision_01", neuron_type: "decision", chosen: " activation key " }],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.predicate_kind).toBe("unique_field");
    expect(v[0]?.reason).toMatch(/chosen/);
    expect(v[0]?.reason).toMatch(/decision_01/);
  });

  it("does not case-fold unless requested", () => {
    const v = evaluate(
      { id: "decision_02", neuron_type: "decision", chosen: "Activation Key" },
      [
        P({
          kind: "unique_field",
          field: "chosen",
          when_neuron_type: ["decision"],
        }),
      ],
      {
        population: [{ id: "decision_01", neuron_type: "decision", chosen: "activation key" }],
      },
    );
    expect(v).toEqual([]);
  });

  it("ignores retired duplicates and empty candidate values", () => {
    const policy = P({
      kind: "unique_field",
      field: "chosen",
      case_fold: true,
      when_neuron_type: ["decision"],
    });
    expect(
      evaluate({ id: "decision_02", neuron_type: "decision", chosen: "Activation key" }, [policy], {
        population: [
          {
            id: "decision_01",
            neuron_type: "decision",
            chosen: "activation key",
            lifecycle: "retired",
          },
        ],
      }),
    ).toEqual([]);
    expect(evaluate({ id: "decision_03", neuron_type: "decision", chosen: " " }, [policy])).toEqual(
      [],
    );
  });
});

describe("authoring evaluator — requires_synapse", () => {
  it("passes when the required outgoing synapse is present", () => {
    const v = evaluate(
      { id: "action_01", neuron_type: "action" },
      [
        P({
          kind: "requires_synapse",
          synapse_type: "serves",
          target_neuron_type: "intent",
          when_neuron_type: ["action"],
        }),
      ],
      {
        candidateSynapses: [{ from_id: "action_01", to_id: "intent_42", synapse_type: "serves" }],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when the candidate carries no matching outgoing synapse", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P({
        kind: "requires_synapse",
        synapse_type: "serves",
        target_neuron_type: "intent",
        when_neuron_type: ["action"],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/serves/);
    expect(v[0]?.reason).toMatch(/intent/);
  });

  it("fails when the synapse exists but points at the wrong neuron type", () => {
    const v = evaluate(
      { id: "action_01", neuron_type: "action" },
      [
        P({
          kind: "requires_synapse",
          synapse_type: "serves",
          target_neuron_type: "intent",
          when_neuron_type: ["action"],
        }),
      ],
      {
        candidateSynapses: [{ from_id: "action_01", to_id: "decision_42", synapse_type: "serves" }],
      },
    );
    expect(v).toHaveLength(1);
  });
});

describe("authoring evaluator — requires_neuron_type", () => {
  it("passes when the candidate's neuron_type is in the allowlist", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P({ kind: "requires_neuron_type", neuron_types: ["action", "intent", "decision"] }),
    ]);
    expect(v).toEqual([]);
  });

  it("fails when the candidate's neuron_type is not in the allowlist", () => {
    const v = evaluate({ id: "log_01", neuron_type: "log" }, [
      P({ kind: "requires_neuron_type", neuron_types: ["action", "intent", "decision"] }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/log/);
  });
});

describe("authoring evaluator — requires_field_resolves_to_principal", () => {
  it("passes when the field resolves to a known Principal id", () => {
    const v = evaluate(
      { id: "action_01", neuron_type: "action", actor_id: "principal_alice" },
      [
        P({
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_neuron_type: ["action"],
        }),
      ],
      { principals: new Set(["principal_alice"]) },
    );
    expect(v).toEqual([]);
  });

  it("fails when the field is empty", () => {
    const v = evaluate(
      { id: "action_01", neuron_type: "action" },
      [
        P({
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_neuron_type: ["action"],
        }),
      ],
      { principals: new Set(["principal_alice"]) },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/empty/);
  });

  it("fails when the field references an unknown id (the BPM bug)", () => {
    const v = evaluate(
      { id: "action_01", neuron_type: "action", actor_id: "principal_ghost" },
      [
        P({
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          when_neuron_type: ["action"],
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
        neuron_type: "intent",
        actors: ["principal_alice", "principal_bob"],
        lifecycle: "active",
      },
      [
        P(
          {
            kind: "graph-completeness",
            list_field: "actors",
            synapse_type: "serves",
            incoming_neuron_type: "action",
            incoming_field_must_match: "actor_id",
            when_neuron_type: ["intent"],
          },
          { fires_when_neuron_lifecycle: ["active"] },
        ),
      ],
      {
        population: [
          { id: "action_01", neuron_type: "action", actor_id: "principal_alice" },
          { id: "action_02", neuron_type: "action", actor_id: "principal_bob" },
        ],
        synapses: [
          { from_id: "action_01", to_id: "intent_01", synapse_type: "serves" },
          { from_id: "action_02", to_id: "intent_01", synapse_type: "serves" },
        ],
      },
    );
    expect(v).toEqual([]);
  });

  it("fails when an actor on the Intent has no matching Action serving it", () => {
    const v = evaluate(
      {
        id: "intent_01",
        neuron_type: "intent",
        actors: ["principal_alice", "principal_bob"],
        lifecycle: "active",
      },
      [
        P(
          {
            kind: "graph-completeness",
            list_field: "actors",
            synapse_type: "serves",
            incoming_neuron_type: "action",
            incoming_field_must_match: "actor_id",
            when_neuron_type: ["intent"],
          },
          { fires_when_neuron_lifecycle: ["active"] },
        ),
      ],
      {
        population: [
          { id: "action_01", neuron_type: "action", actor_id: "principal_alice" },
          // No Action for principal_bob.
        ],
        synapses: [{ from_id: "action_01", to_id: "intent_01", synapse_type: "serves" }],
      },
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.reason).toMatch(/principal_bob/);
  });

  it("fails when the matching Action exists but lacks the serves synapse", () => {
    const v = evaluate(
      { id: "intent_01", neuron_type: "intent", actors: ["principal_alice"], lifecycle: "active" },
      [
        P(
          {
            kind: "graph-completeness",
            list_field: "actors",
            synapse_type: "serves",
            incoming_neuron_type: "action",
            incoming_field_must_match: "actor_id",
            when_neuron_type: ["intent"],
          },
          { fires_when_neuron_lifecycle: ["active"] },
        ),
      ],
      {
        population: [{ id: "action_01", neuron_type: "action", actor_id: "principal_alice" }],
        synapses: [], // No synapse → Intent.
      },
    );
    expect(v).toHaveLength(1);
  });

  it("does not fire on drafting Intents (lifecycle filter)", () => {
    const v = evaluate(
      {
        id: "intent_01",
        neuron_type: "intent",
        actors: ["principal_alice"],
        lifecycle: "drafting",
      },
      [
        P(
          {
            kind: "graph-completeness",
            list_field: "actors",
            synapse_type: "serves",
            incoming_neuron_type: "action",
            incoming_field_must_match: "actor_id",
            when_neuron_type: ["intent"],
          },
          { fires_when_neuron_lifecycle: ["active"] },
        ),
      ],
    );
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — probabilistic", () => {
  it("emits a pending violation with the spec for the LLM judge", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P({
        kind: "probabilistic",
        spec: "Action summary reads as an atomic business activity, not an umbrella phase.",
        when_neuron_type: ["action"],
      }),
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]?.predicate_kind).toBe("probabilistic");
    expect(v[0]?.pending_spec).toMatch(/atomic business activity/);
  });
});

describe("authoring evaluator — descriptive", () => {
  it("never produces a violation", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P({ kind: "descriptive", spec: "Just a note for readers." }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("authoring evaluator — on_violation propagation", () => {
  it("default on_violation is block", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P({ kind: "requires_field", fields: ["actor_id"], when_neuron_type: ["action"] }),
    ]);
    expect(v[0]?.on_violation).toBe("block");
  });

  it("warn propagates", () => {
    const v = evaluate({ id: "action_01", neuron_type: "action" }, [
      P(
        { kind: "requires_field", fields: ["actor_id"], when_neuron_type: ["action"] },
        { on_violation: "warn" },
      ),
    ]);
    expect(v[0]?.on_violation).toBe("warn");
  });
});
