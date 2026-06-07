import { describe, expect, it } from "vitest";
import type { DeterministicPredicate } from "../entities.js";
import {
  agentInstructionParts,
  deterministicHeadline,
  deterministicParts,
  summarizePredicate,
} from "../policy-format.js";

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

describe("deterministicParts labels the incoming-edge exemption clearly", () => {
  // "exempt when incoming: has_parent" read as if the REQUIRED relationship were
  // incoming. The exemption is the opposite of the requirement: the floor wants
  // an OUTGOING edge, and a node is excused only when it is itself the TARGET of
  // an incoming edge of this type (a parent/container). The label must say so.
  it("renders exempt_when_incoming_edge_type as 'exempt when target of incoming'", () => {
    const parts = deterministicParts({
      sub_kind: "requires_edge",
      edge_type: "has_parent",
      target_node_type: "action",
      direction: "outgoing",
      exempt_when_incoming_edge_type: "has_parent",
    } as DeterministicPredicate);
    expect(parts).toContainEqual({ label: "edge type", value: "has_parent" });
    expect(parts).toContainEqual({ label: "direction", value: "outgoing" });
    expect(parts).toContainEqual({
      label: "exempt when target of incoming",
      value: "has_parent",
    });
  });
});

describe("deterministic rendering tolerates an unknown sub_kind", () => {
  // A stored policy whose `sub_kind` is no longer in the registry (legacy /
  // imported / hand-edited jsonb) must still render. Before, these helpers
  // indexed the registry blindly and threw, taking down the whole policies
  // page with `undefined is not an object (evaluating 'w[e].fields')`.
  const orphan = { sub_kind: "obsolete_check", edge_type: "supports" } as DeterministicPredicate;

  it("yields no parts instead of throwing", () => {
    expect(() => deterministicParts(orphan)).not.toThrow();
    expect(deterministicParts(orphan)).toEqual([]);
  });

  it("uses the raw sub_kind as the headline", () => {
    expect(deterministicHeadline(orphan)).toBe("obsolete_check");
  });

  it("summarizes to the raw sub_kind without throwing", () => {
    expect(() => summarizePredicate(orphan)).not.toThrow();
    expect(summarizePredicate(orphan)).toBe("obsolete_check");
  });
});
