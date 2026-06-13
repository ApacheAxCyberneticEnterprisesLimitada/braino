import {
  type CandidateFields,
  type EngineEdge,
  type LoadedPolicy,
  evaluateEdgePolicies,
  evaluatePolicies,
} from "@doco/shared";
import { describe, expect, it } from "vitest";
import { DECISION_RECORD_TEMPLATES } from "../decision-record-templates.js";
import {
  type DocoTemplate,
  type TemplatePolicy,
  findDocoTemplateByName,
  templatePolicyToPolicyRow,
} from "../doco-templates.js";

const FLAVOR_HANDLES = [
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
] as const;

/** Seed a TemplatePolicy into the LoadedPolicy the real evaluator consumes. */
function loaded(p: TemplatePolicy): LoadedPolicy {
  const row = templatePolicyToPolicyRow(p);
  return {
    policy_id: "policy_test",
    kind: row.kind,
    predicate: row.predicate as unknown as LoadedPolicy["predicate"],
    ...(row.on_violation ? { on_violation: row.on_violation } : {}),
    ...(row.fires_when_node_lifecycle
      ? { fires_when_node_lifecycle: row.fires_when_node_lifecycle }
      : {}),
  };
}

function policyByPredicateKind(t: DocoTemplate, kind: string): TemplatePolicy {
  const p = t.policies.find((r) => r.predicate?.kind === kind);
  if (!p) throw new Error(`${t.name} has no policy with predicate kind \`${kind}\``);
  return p;
}

function runNode(
  policy: TemplatePolicy,
  candidate: CandidateFields,
  extras: { candidateEdges?: EngineEdge[]; edges?: EngineEdge[] } = {},
) {
  return evaluatePolicies({
    candidate,
    policies: [loaded(policy)],
    candidateEdges: extras.candidateEdges ?? [],
    edges: extras.edges ?? [],
    principals: new Set(),
    population: [],
  });
}

describe("the three decision-record templates are registered", () => {
  it("ships exactly the three flavors from the shared core", () => {
    expect(DECISION_RECORD_TEMPLATES.map((t) => t.name).sort()).toEqual([...FLAVOR_HANDLES].sort());
  });

  for (const handle of FLAVOR_HANDLES) {
    it(`registers \`${handle}\` and is findable by handle`, () => {
      const t = findDocoTemplateByName(handle);
      expect(t).toBeDefined();
      expect(t?.name).toBe(handle);
    });
  }
});

describe("every decision-record template shares the core shape", () => {
  for (const handle of FLAVOR_HANDLES) {
    const t = findDocoTemplateByName(handle);
    if (!t) throw new Error(`${handle} not registered`);

    describe(handle, () => {
      it("has an icon, a label, a non-trivial description, and a single-emoji label", () => {
        expect(t.icon).toBeTruthy();
        expect(t.label).toBeTruthy();
        expect(t.description.length).toBeGreaterThan(20);
      });

      it("defaults new decisions to drafting and opens on the List perspective (the decision log)", () => {
        expect(t.defaultNodeLifecycle).toBe("drafting");
        expect(t.perspectives).toEqual([{ slug: "list", isDefault: true }]);
      });

      it("allows exactly the decision-record node types — no flow nodes", () => {
        const allow = policyByPredicateKind(t, "requires_node_type").predicate;
        if (allow?.kind !== "requires_node_type") throw new Error("missing node allowlist");
        expect([...allow.node_types].sort()).toEqual(
          ["decision", "eval", "principal", "reference", "rule"].sort(),
        );
        expect(allow.node_types).not.toContain("action");
        expect(allow.node_types).not.toContain("state");
        expect(allow.node_types).not.toContain("intent");
      });

      it("allows the decision-web edge types and bars flow/hierarchy edges", () => {
        const allow = policyByPredicateKind(t, "requires_edge_type").predicate;
        if (allow?.kind !== "requires_edge_type") throw new Error("missing edge allowlist");
        expect(new Set(allow.edge_types)).toEqual(
          new Set([
            "attributed_to",
            "constrained_by",
            "supports",
            "replaces",
            "derived_from",
            "relates_to",
          ]),
        );
        expect(allow.edge_types).not.toContain("flows_to");
        expect(allow.edge_types).not.toContain("has_parent");
      });

      it("requires `chosen` and a decider Principal only once committed (queued + active), never drafting", () => {
        const chosen = t.policies.find(
          (r) =>
            r.predicate?.kind === "requires_field" &&
            r.predicate.fields.includes("chosen") &&
            (r.predicate.when_node_type?.includes("decision") ?? false),
        );
        expect(chosen?.fires_when_node_lifecycle).toEqual(["queued", "active"]);

        const decider = t.policies.find(
          (r) =>
            r.predicate?.kind === "requires_edge" &&
            r.predicate.edge_type === "attributed_to" &&
            r.predicate.target_node_type === "principal" &&
            (r.predicate.when_node_type?.includes("decision") ?? false),
        );
        expect(decider?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      });

      it("documents the status→lifecycle mapping, append-only supersession, and one-decision-per-record", () => {
        const guidance = t.policies.filter((r) => !r.predicate).map((r) => r.policy ?? "");
        const haystack = guidance.join("\n");
        // Status maps onto the four lifecycle stages.
        expect(haystack).toMatch(/drafting/i);
        expect(haystack).toMatch(/proposed/i);
        expect(haystack).toMatch(/accepted/i);
        expect(haystack).toMatch(/superseded/i);
        // Append-only: supersede via a `replaces` edge, don't rewrite.
        expect(haystack).toMatch(/append-only/i);
        expect(haystack).toMatch(/`replaces`/);
        // One decision per record.
        expect(haystack).toMatch(/exactly one decision/i);
        // Drivers as Rules, evidence as Evals — wired by edge.
        expect(haystack).toMatch(/`constrained_by`/);
        expect(haystack).toMatch(/`supports`/);
        // Agents are pointed at the authoring contract + changesets.
        expect(haystack).toMatch(/authoring-contract\.json/);
        expect(haystack).toMatch(/changesets\.json/);
      });

      it("carries a domain-fit gate that warns (never blocks) and is scoped to decisions", () => {
        const fit = t.policies.find(
          (r) =>
            r.predicate?.kind === "probabilistic" &&
            /\bPASS when it records\b/i.test(r.predicate.spec),
        );
        expect(fit?.on_violation).toBe("warn");
        if (fit?.predicate?.kind !== "probabilistic") throw new Error("missing fit gate");
        expect(fit.predicate.when_node_type).toEqual(["decision"]);
      });

      it("declares no top-level policy `kind` (classification happens at seed time)", () => {
        for (const p of t.policies) expect(p).not.toHaveProperty("kind");
      });

      it("gates the two committed stages identically — no queued-only or active-only policy", () => {
        for (const p of t.policies) {
          const l = p.fires_when_node_lifecycle;
          if (!l) continue;
          expect(l.includes("queued")).toBe(l.includes("active"));
        }
      });

      it("never blocks on an LLM-judged (probabilistic) verdict — those are nudges", () => {
        for (const p of t.policies) {
          if (p.predicate?.kind === "probabilistic") {
            expect(p.on_violation ?? "block").toBe("warn");
          }
        }
      });
    });
  }
});

describe("the domain-fit gates differ per flavor", () => {
  function fitSpec(handle: string): string {
    const t = findDocoTemplateByName(handle);
    const fit = t?.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" && /\bPASS when it records\b/i.test(r.predicate.spec),
    );
    if (fit?.predicate?.kind !== "probabilistic") throw new Error(`${handle} has no fit gate`);
    return fit.predicate.spec;
  }

  it("ADR keys on architectural significance and subsumes data-modeling/governance", () => {
    const adr = fitSpec("architectural-decisions");
    expect(adr).toMatch(/architecturally significant|quality attribute/i);
    // The data flavor folded into the ADR log, so its fit gate now also admits
    // data-modeling, storage, pipeline, and governance decisions.
    expect(adr).toMatch(/schema|storage|pipeline|governance/i);
  });
  it("product keys on what-to-build for users / business goal", () => {
    expect(fitSpec("product-decisions")).toMatch(/what to build|user problem|business goal/i);
  });
  it("design keys on UX / user needs / design principles", () => {
    expect(fitSpec("design-decisions")).toMatch(/UX|user needs|design principles/i);
  });
});

// ── Behavioral: run the seeded gates through the REAL evaluator ──────────────
describe("decision-record gates fire correctly through the real evaluator", () => {
  // One flavor exercises the shared core; the core is identical across all three.
  const t = findDocoTemplateByName("architectural-decisions");
  if (!t) throw new Error("architectural-decisions not registered");

  const nodeAllowlist = policyByPredicateKind(t, "requires_node_type");
  const edgeAllowlist = policyByPredicateKind(t, "requires_edge_type");
  const chosenGate = t.policies.find(
    (r) => r.predicate?.kind === "requires_field" && r.predicate.fields.includes("chosen"),
  );
  const deciderGate = t.policies.find(
    (r) =>
      r.predicate?.kind === "requires_edge" &&
      r.predicate.edge_type === "attributed_to" &&
      r.predicate.target_node_type === "principal",
  );
  if (!chosenGate || !deciderGate) throw new Error("core completeness gates missing");

  it("node-type allowlist admits a Decision and rejects an Action", () => {
    expect(runNode(nodeAllowlist, { id: "decision_01", node_type: "decision" })).toEqual([]);
    const v = runNode(nodeAllowlist, { id: "action_01", node_type: "action" });
    expect(v).toHaveLength(1);
    expect(v[0]?.sub_kind).toBe("requires_node_type");
  });

  it("edge-type allowlist admits `attributed_to` and bars `flows_to`", () => {
    const policies = [loaded(edgeAllowlist)];
    expect(evaluateEdgePolicies({ edge: { edge_type: "attributed_to" }, policies })).toEqual([]);
    const barred = evaluateEdgePolicies({ edge: { edge_type: "flows_to" }, policies });
    expect(barred).toHaveLength(1);
    expect(barred[0]?.sub_kind).toBe("requires_edge_type");
  });

  it("a queued Decision without `chosen` is blocked; with `chosen` it passes", () => {
    const missing = runNode(chosenGate, {
      id: "decision_01",
      node_type: "decision",
      lifecycle: "queued",
      chosen: null,
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.reason).toMatch(/chosen/);

    expect(
      runNode(chosenGate, {
        id: "decision_01",
        node_type: "decision",
        lifecycle: "queued",
        chosen: "Postgres",
      }),
    ).toEqual([]);
  });

  it("a drafting Decision may leave `chosen` open — the gate does not fire", () => {
    expect(
      runNode(chosenGate, {
        id: "decision_01",
        node_type: "decision",
        lifecycle: "drafting",
        chosen: null,
      }),
    ).toEqual([]);
  });

  it("a queued Decision needs an `attributed_to` edge to a Principal; a drafting one does not", () => {
    const candidate: CandidateFields = {
      id: "decision_01",
      node_type: "decision",
      lifecycle: "queued",
    };
    expect(runNode(deciderGate, candidate)).toHaveLength(1);
    expect(
      runNode(deciderGate, candidate, {
        candidateEdges: [
          { from_id: "decision_01", to_id: "principal_01", edge_type: "attributed_to" },
        ],
      }),
    ).toEqual([]);
    expect(
      runNode(deciderGate, { id: "decision_01", node_type: "decision", lifecycle: "drafting" }),
    ).toEqual([]);
  });
});
