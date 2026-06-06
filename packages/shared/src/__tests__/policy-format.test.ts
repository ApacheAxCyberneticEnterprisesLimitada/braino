import { describe, expect, it } from "vitest";
import { agentInstructionParts } from "../policy-format.js";

describe("agentInstructionParts", () => {
  it("surfaces the node type a node-scoped predicate is scoped to", () => {
    // A probabilistic node check carries `when_node_type` — the node type(s) it
    // judges. The list/policy page must show that scope, so it renders as a
    // labeled part the same way deterministic predicates do.
    expect(
      agentInstructionParts({
        agent_instruction: "Check the Principal's prose.",
        when_node_type: ["principal"],
      }),
    ).toEqual([{ label: "when node type", value: "principal" }]);
  });

  it("joins multiple scoped node types", () => {
    expect(
      agentInstructionParts({
        agent_instruction: "Judge the node.",
        when_node_type: ["action", "decision"],
      }),
    ).toEqual([{ label: "when node type", value: "action, decision" }]);
  });

  it("yields no parts for an unscoped node predicate (fires on every node)", () => {
    expect(agentInstructionParts({ agent_instruction: "Always applies." })).toEqual([]);
  });

  it("surfaces the edge and its endpoints for an edge-scoped predicate", () => {
    // An edge-scoped probabilistic policy fires on edge creation; the judge sees
    // both endpoints. Show the edge type and whichever endpoint types it pins.
    expect(
      agentInstructionParts({
        agent_instruction: "Judge the relationship.",
        edge_type: "supports",
        from_node_type: "intent",
        to_node_type: "decision",
      }),
    ).toEqual([
      { label: "edge type", value: "supports" },
      { label: "from node type", value: "intent" },
      { label: "to node type", value: "decision" },
    ]);
  });

  it("omits unset endpoints on an edge-scoped predicate", () => {
    expect(
      agentInstructionParts({
        agent_instruction: "Judge the relationship.",
        edge_type: "supports",
      }),
    ).toEqual([{ label: "edge type", value: "supports" }]);
  });
});
