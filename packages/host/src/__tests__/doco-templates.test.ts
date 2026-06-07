import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCO_TEMPLATES,
  findDocoTemplateByName,
  templatePolicyToPolicyRow,
} from "../doco-templates.js";

describe("template policies carry no vestigial rule `kind`", () => {
  // Rules are no longer guidances: every policy lives in the one unified
  // `policies` table, classified by a standalone `kind` only at seed time
  // in host.ts — a TemplatePolicy never carries a `kind` field itself
  // (decision_01KRRR5BQ16ASY8HQEE0V499YG). Keep the vestige out for good.
  it("no seeded template policy declares a `kind`", () => {
    for (const t of DEFAULT_DOCO_TEMPLATES) {
      for (const p of t.policies) {
        expect(p).not.toHaveProperty("kind");
      }
    }
  });
});

describe("orphaned pre-unification templates are gone", () => {
  // `global` and `important` were never in the new-Doco picker
  // (DOCO_TEMPLATES); the API and UI reject any handle outside that list,
  // so both were unreachable. `global` also still seeded the removed
  // `guidance_policy` / `node_authoring_policy` node types into the
  // write-only `allowed_node_types` column. Both removed with the policy
  // unify — keep them out.
  for (const name of ["global", "important"]) {
    it(`does not register the orphaned \`${name}\` template`, () => {
      expect(findDocoTemplateByName(name)).toBeUndefined();
      expect(DEFAULT_DOCO_TEMPLATES.some((t) => t.name === name)).toBe(false);
    });
  }
});

describe("removed templates are gone", () => {
  // The glossaries, org-chart, and four decision-record templates were
  // deleted; only `process` and `github-pull-requests` ship now. Keep them
  // out so a request for a removed handle can't resurrect a half-wired
  // template.
  for (const name of [
    "glossaries",
    "org-chart",
    "architectural-decisions",
    "product-decisions",
    "design-decisions",
    "data-decisions",
  ]) {
    it(`does not register the removed \`${name}\` template`, () => {
      expect(findDocoTemplateByName(name)).toBeUndefined();
      expect(DEFAULT_DOCO_TEMPLATES.some((t) => t.name === name)).toBe(false);
    });
  }

  it("ships exactly the surviving templates", () => {
    expect(DEFAULT_DOCO_TEMPLATES.map((t) => t.name).sort()).toEqual([
      "github-pull-requests",
      "process",
    ]);
  });
});

describe("process template", () => {
  const template = findDocoTemplateByName("process");
  if (!template) throw new Error("process template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "process")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("process");
    const hashtagged = findDocoTemplateByName("#process");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("process");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("🔁");
    expect(template.label).toBe("process");
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/repeatable business processes/i);
    expect(template.description).toMatch(/BPMN/);
  });

  it("ships with the BPMN perspective attached as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "process", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("includes only process node types (no Intent — a process is an Action)", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["action", "decision", "eval", "principal", "reference", "rule", "state"].sort(),
      );
      expect(allowlist.node_types).not.toContain("intent");
    });

    it("does not list Doco policy metadata as business-process content", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("guidance_policy" as never);
      expect(allowlist.node_types).not.toContain("node_authoring_policy" as never);
    });

    it("describes only business-process nodes, not Doco policy metadata", () => {
      const policy = template.policies.find(
        (r) => r.predicate?.kind === "requires_node_type",
      )?.policy;
      expect(policy ?? "").toMatch(
        /Only Action, Decision, State, Eval, Reference, Rule, and Principal/i,
      );
      expect(policy ?? "").not.toMatch(/guidance_policy|node_authoring_policy|policy records/i);
    });

    it("excludes Log and Idea (Logs live in a sibling Doco; Ideas live in their own home)", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("log");
      expect(allowlist.node_types).not.toContain("idea");
    });
  });

  describe("requires_field rules", () => {
    function requiresField(field: string, entityType: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_field" &&
          r.predicate.fields.includes(field) &&
          r.predicate.when_node_type?.includes(entityType as never),
      );
    }

    it("does not require relationship keys in node JSON", () => {
      expect(requiresField("actor_id", "action")).toBeUndefined();
      expect(requiresField("target_ref", "eval")).toBeUndefined();
      expect(requiresField("actors", "intent")).toBeUndefined();
      expect(requiresField("stakeholders", "intent")).toBeUndefined();
      expect(requiresField("inputs", "action")).toBeUndefined();
      expect(requiresField("outputs", "action")).toBeUndefined();
    });
  });

  describe("requires_edge rules", () => {
    // With `role` gone, each gate that used to be `requires_edge_role` is now a
    // role-free `requires_edge` distinguished by edge_type + target_node_type +
    // the candidate node type (`when_node_type`). E.g. the Action-performer gate
    // is `requires_edge`(attributed_to → principal) scoped to `action`; the
    // membership gate is `requires_edge`(has_parent → action) scoped to the flow node.
    function requiresEdge(edgeType: string, target: string | null, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === edgeType &&
          (target === null
            ? r.predicate.target_node_type === undefined
            : r.predicate.target_node_type === target) &&
          (r.predicate.when_node_type?.includes(on as never) ?? false) &&
          // Exclude the incoming actor-coverage gate (direction: incoming),
          // which also matches attributed_to but is a different rule.
          r.predicate.direction !== "incoming",
      );
    }

    it("Action belongs to a process (has_parent → action)", () => {
      expect(requiresEdge("has_parent", "action", "action")).toBeDefined();
    });
    it("Decision belongs to a process (has_parent → action)", () => {
      expect(requiresEdge("has_parent", "action", "decision")).toBeDefined();
    });
    it("State belongs to a process (has_parent → action)", () => {
      expect(requiresEdge("has_parent", "action", "state")).toBeDefined();
    });
    it("Action attributed to its performer Principal (attributed_to → principal)", () => {
      expect(requiresEdge("attributed_to", "principal", "action")).toBeDefined();
    });
    it("Decision attributed to its decider Principal (attributed_to → principal)", () => {
      // A gateway routes the flow, but a role, team, or system is
      // accountable for how it is decided. Require that decider explicitly,
      // mirroring the Action performer gate. With roles gone, a Decision's
      // `attributed_to` edge to a Principal IS its decider (source = decision).
      expect(requiresEdge("attributed_to", "principal", "decision")).toBeDefined();
    });
    it("Decision decider edge fires only on committed stages (queued + active), NOT drafting", () => {
      // A gateway may be sketched without a decider; the decider Principal is
      // required once it is committed (`queued`/`active`), not while drafting.
      expect(
        requiresEdge("attributed_to", "principal", "decision")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Action performer edge fires only on committed stages (queued + active), NOT drafting", () => {
      // An Action may be sketched without an actor; the performing Principal is
      // required once it is committed, not while drafting.
      expect(
        requiresEdge("attributed_to", "principal", "action")?.fires_when_node_lifecycle,
      ).toEqual(["queued", "active"]);
    });
    it("Eval tests a target (supports, any endpoint)", () => {
      const rule = requiresEdge("supports", null, "eval");
      expect(rule).toBeDefined();
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("fires the process-membership gate only on committed stages, NOT drafting", () => {
      // Completeness, not Principal-attachment: belonging to a process is
      // deferrable while drafting (a step can be sketched before its parent
      // process/pool is chosen), so the gate fires only on `queued`/`active`.
      // The Principal attribution gates above still fire in `drafting`.
      expect(requiresEdge("has_parent", "action", "action")?.fires_when_node_lifecycle).toEqual([
        "queued",
        "active",
      ]);
      expect(requiresEdge("has_parent", "action", "decision")?.fires_when_node_lifecycle).toEqual([
        "queued",
        "active",
      ]);
      expect(requiresEdge("has_parent", "action", "state")?.fires_when_node_lifecycle).toEqual([
        "queued",
        "active",
      ]);
    });

    it("exempts a process container (incoming has_parent) from the membership floor", () => {
      // The membership floor is a hard block, but a top-level process Action —
      // the TARGET of its children's `has_parent` — is the root and is excused
      // via exempt_when_incoming_edge_type so it is never falsely blocked.
      const floor = requiresEdge("has_parent", "action", "action");
      expect(floor?.predicate?.kind).toBe("requires_edge");
      if (floor?.predicate?.kind !== "requires_edge") return;
      expect(floor.predicate.exempt_when_incoming_edge_type).toBe("has_parent");
      // A hard block (default), not a warn.
      expect(floor.on_violation ?? "block").toBe("block");
    });

    it("describes edge meaning by type + endpoint node types, never a role tag", () => {
      // The guidance must NOT reintroduce role tokens as edge roles, and the
      // BPMN-vocabulary guidance now derives meaning from edge type + endpoints.
      const policies = template.policies.map((r) => r.policy ?? "").join("\n");
      expect(policies).toMatch(/an edge's meaning comes from its type plus the node types/i);
      expect(policies).toMatch(/`attributed_to` edge to a Principal drives actor lanes/i);
      expect(policies).toMatch(/`supports` edge from an Eval tests/i);
      expect(policies).toMatch(/`constrained_by` edge to a Rule/i);
      // No retired role vocabulary leaks back into the prose.
      expect(policies).not.toMatch(/`serves`|`performed_by`|`decided_by`|`owned_by`|`gated_by`/);
      expect(policies).not.toMatch(/role `\w+`|carrying role|with role metadata|role examples/i);
    });
  });

  describe("a flow node belongs to exactly one process (membership ceiling)", () => {
    // The membership floor (requires_edge has_parent → action, ≥1) gets a
    // matching CEILING: every flow node has AT MOST one `has_parent`, so it
    // belongs to exactly one BPMN pool. A role-free `limits_edge`(has_parent →
    // action, max 1). Like the floor, the ceiling fires only on the committed
    // stages (`queued`/`active`) — a `drafting` sketch is exempt.
    const ceiling = template.policies.find(
      (r) =>
        r.predicate?.kind === "limits_edge" &&
        r.predicate.edge_type === "has_parent" &&
        r.predicate.target_node_type === "action",
    );

    it("seeds a limits_edge gate on the `has_parent` edge to a process Action, capped at one", () => {
      expect(ceiling?.predicate?.kind).toBe("limits_edge");
      if (ceiling?.predicate?.kind !== "limits_edge") return;
      expect(ceiling.predicate.target_node_type).toBe("action");
      expect(ceiling.predicate.max_count).toBe(1);
      expect([...(ceiling.predicate.when_node_type ?? [])].sort()).toEqual([
        "action",
        "decision",
        "state",
      ]);
    });

    it("blocks (hard) and fires only on committed stages — NOT drafting", () => {
      // A node never belongs to two processes once committed; while drafting the
      // ceiling is exempt, symmetric with the membership floor it complements.
      expect(ceiling?.on_violation ?? "block").toBe("block");
      expect(ceiling?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("seeds as a deterministic policy carrying the predicate verbatim", () => {
      if (!ceiling) throw new Error("ceiling gate missing");
      const seeded = templatePolicyToPolicyRow(ceiling);
      expect(seeded.kind).toBe("deterministic");
      expect(seeded.on_violation).toBe("block");
      expect(seeded.predicate.sub_kind).toBe("limits_edge");
      expect(seeded.predicate.edge_type).toBe("has_parent");
      expect(seeded.predicate.target_node_type).toBe("action");
      expect(seeded.predicate.max_count).toBe(1);
      expect(seeded.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("no Intent / subprocess-naming policies remain", () => {
    it("seeds no edge-probabilistic subprocess-naming policy (a process is an Action now)", () => {
      expect(
        template.policies.find((r) => r.predicate?.kind === "edge-probabilistic"),
      ).toBeUndefined();
    });

    it("scopes no policy to the Intent node type", () => {
      for (const p of template.policies) {
        const pred = p.predicate;
        if (pred && "when_node_type" in pred && pred.when_node_type) {
          expect(pred.when_node_type).not.toContain("intent" as never);
        }
      }
    });
  });

  describe("Principal lane shape", () => {
    const principalRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("principal") &&
        /role, team, external party, or system/i.test(r.predicate.spec),
    );

    it("warns when a Principal does not read as a process swim-lane actor", () => {
      expect(principalRule?.on_violation).toBe("warn");
      expect(principalRule?.predicate?.kind).toBe("probabilistic");
      if (principalRule?.predicate?.kind !== "probabilistic") return;
      expect(principalRule.predicate.spec).toMatch(/role, team, external party, or system/i);
      expect(principalRule.predicate.spec).toMatch(/responsibility|boundary/i);
    });
  });

  describe("State wiring", () => {
    // The per-node sequence-flow + uniqueness invariants are now ENGINE-checked
    // (deterministic), not prose-only. Doco-level existence ("≥1 initial, ≥1
    // terminal") can't be a per-candidate predicate, so it stays guidance.
    const guidanceSummaries = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy ?? "");

    it("≥1 active initial State is documented (doco-level, stays guidance)", () => {
      expect(guidanceSummaries.some((s) => /\binitial\b/i.test(s) && /≥1|at least/i.test(s))).toBe(
        true,
      );
    });
    it("≥1 active terminal State is documented (doco-level, stays guidance)", () => {
      expect(guidanceSummaries.some((s) => /\bterminal\b/i.test(s) && /≥1|at least/i.test(s))).toBe(
        true,
      );
    });

    it("State milestone-name uniqueness is ENFORCED via unique_field", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "unique_field" && r.predicate.when_node_type?.includes("state"),
      );
      expect(rule?.predicate?.kind).toBe("unique_field");
      if (rule?.predicate?.kind !== "unique_field") return;
      expect(rule.predicate.field).toBe("state");
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("sequence-flow completeness is ENFORCED via flow-wiring (the dangling-node fix)", () => {
      const rule = template.policies.find((r) => r.predicate?.kind === "flow-wiring");
      expect(rule?.predicate?.kind).toBe("flow-wiring");
      if (rule?.predicate?.kind !== "flow-wiring") return;
      expect(rule.predicate.edge_type).toBe("flows_to");
      expect(rule.predicate.when_node_type).toEqual(["action", "decision", "state"]);
      expect(rule.predicate.initial_when).toEqual({ field: "kind", equals: "initial" });
      expect(rule.predicate.terminal_when).toEqual({ field: "kind", equals: "terminal" });
      // Committed-only: a drafting sketch may dangle.
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      // The summary still spells out the terminal + forward-flow shape for agents.
      expect(rule.policy).toMatch(/terminal/i);
      expect(rule.policy).toMatch(/no outgoing.*flows_to/i);
      expect(rule.policy).toMatch(/forward/i);
    });
  });

  describe("actor coverage (enforced)", () => {
    it("ENFORCES that each actor Principal is named by ≥1 Action's attributed_to", () => {
      // The per-step coverage gate is an INCOMING `requires_edge`(attributed_to)
      // on a Principal, constrained so the far (from) end is an Action. The
      // process owner is covered too — a process is an Action, so the edge naming
      // its owner is itself "an Action's attributed_to", needing no exemption.
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === "attributed_to" &&
          r.predicate.direction === "incoming",
      );
      expect(rule?.predicate?.kind).toBe("requires_edge");
      if (rule?.predicate?.kind !== "requires_edge") return;
      expect(rule.predicate.edge_type).toBe("attributed_to");
      expect(rule.predicate.target_node_type).toBe("action");
      // No Intent exemption — the Intent node type is gone from the process model.
      expect(rule.predicate.exempt_when_other_node_type).toBeUndefined();
      expect(rule.predicate.when_node_type).toEqual(["principal"]);
      expect(rule.on_violation).toBe("warn");
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
  });

  describe("deterministic floors under the LLM judges", () => {
    it("a gateway Decision needs ≥2 outgoing flows_to (structural floor under the exhaustiveness judge)", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === "flows_to" &&
          (r.predicate.when_node_type?.includes("decision") ?? false),
      );
      expect(rule?.predicate?.kind).toBe("requires_edge");
      if (rule?.predicate?.kind !== "requires_edge") return;
      expect(rule.predicate.min_count).toBe(2);
      expect(rule.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });

    it("a deterministic pattern floor blocks raw BPMN/import scaffolding tokens", () => {
      const rule = template.policies.find((r) => r.predicate?.kind === "forbids_field_pattern");
      expect(rule?.predicate?.kind).toBe("forbids_field_pattern");
      if (rule?.predicate?.kind !== "forbids_field_pattern") return;
      // Catches camelCase BPMN element types and generated ids.
      expect("exclusiveGateway").toMatch(new RegExp(rule.predicate.pattern, rule.predicate.flags));
      expect("Gateway_0x1f").toMatch(new RegExp(rule.predicate.pattern, rule.predicate.flags));
      // Leaves ordinary business prose alone.
      expect("approve the invoice").not.toMatch(
        new RegExp(rule.predicate.pattern, rule.predicate.flags),
      );
    });
  });

  describe("no policy grades a single line", () => {
    // Line-shaped grading distorts a field's vector embedding and forces a
    // headline structure into prose. Checks run over the whole field instead;
    // additional structure belongs in a separate field. This guards every
    // template against reintroducing the retired `field-line-shape` predicate
    // or a "first line"-scoped probabilistic spec.
    for (const t of DEFAULT_DOCO_TEMPLATES) {
      it(`${t.name} has no line-scoped policy`, () => {
        for (const p of t.policies) {
          expect(p.predicate?.kind, `${t.name} still uses field-line-shape`).not.toBe(
            "field-line-shape",
          );
          if (p.predicate?.kind === "probabilistic") {
            expect(p.predicate.spec, `${t.name} probabilistic spec scopes to a line`).not.toMatch(
              /first line|line one|the first line/i,
            );
          }
        }
      });
    }
  });

  describe("probabilistic specs cover process-critical claims", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy ?? "");
    const haystack = [...specs, ...summaries].join("\n");

    it("exhaustive gateway / branches", () => {
      expect(/exhaustive|default\/else|enum/i.test(haystack)).toBe(true);
    });
    it("keeps gateway completeness as an assertion-time check", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_node_type?.includes("decision") &&
          /default\/else|enumerat/i.test(r.predicate.spec),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
    it("keeps Action grain as an assertion-time check", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          /single business activity/i.test(r.predicate.spec),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    });
    it("blocks imported BPMN/source metadata in user-facing process prose", () => {
      const rule = template.policies.find(
        (r) => r.predicate?.kind === "probabilistic" && /Source type/i.test(r.predicate.spec ?? ""),
      );
      expect(rule?.on_violation).toBe("block");
      expect(rule?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      expect(rule?.predicate?.kind).toBe("probabilistic");
      if (rule?.predicate?.kind !== "probabilistic") return;
      expect(rule.predicate.when_node_type).toEqual(
        expect.arrayContaining(["action", "decision", "state", "eval", "rule"]),
      );
      expect(rule.predicate.when_node_type).not.toContain("reference");
      expect(rule.predicate.when_node_type).not.toContain("intent");
      expect(rule.predicate.spec).toMatch(/Implementation status/i);
      expect(rule.predicate.spec).toMatch(/Source type/i);
      expect(rule.predicate.spec).toMatch(/exclusiveGateway/i);
      expect(rule.predicate.spec).toMatch(/visible prose/i);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy ?? "");

    it("tells agents to use the authoring contract and changesets", () => {
      expect(
        summaries.some((s) => /authoring-contract\.json/i.test(s) && /changesets\.json/i.test(s)),
      ).toBe(true);
    });
    it("tells agents to use relate_many for gateway siblings", () => {
      expect(summaries.some((s) => /relate_many/i.test(s) && /gateway/i.test(s))).toBe(true);
    });
    it("tells agents a subprocess is a member Action with its own has_parent children", () => {
      // A subprocess is no longer a calling-Action ↔ purpose-Intent pairing: it
      // is simply a member Action that itself has `has_parent` children.
      expect(summaries.some((s) => /sub-?process/i.test(s) && /has_parent/i.test(s))).toBe(true);
    });
    it("documents the four-stage lifecycle (drafting → queued → active → retired) and its changeset ops", () => {
      expect(
        summaries.some(
          (s) =>
            /drafting/i.test(s) &&
            /queued/i.test(s) &&
            /active/i.test(s) &&
            /\bqueue\b/i.test(s) &&
            /\bactivate\b/i.test(s),
        ),
      ).toBe(true);
    });
    it("documents using `queued` for a ready-but-not-yet-in-force process", () => {
      expect(
        summaries.some(
          (s) => /`queued`/i.test(s) && /ready/i.test(s) && /not yet in force/i.test(s),
        ),
      ).toBe(true);
    });
    it("Log separation (instances live in a sibling Doco)", () => {
      expect(
        summaries.some(
          (s) => /instance/i.test(s) && /(separate|sibling) doco/i.test(s) && /reference/i.test(s),
        ),
      ).toBe(true);
    });
    it("BPMN sequence flow is forward-only and rendered without reversal", () => {
      expect(summaries.some((s) => /flows_to/i.test(s) && /source -> target/i.test(s))).toBe(true);
    });
  });

  describe("relationships are edge-only", () => {
    const guidanceSummaries = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy ?? "");
    const edgeGuidance = guidanceSummaries.find((s) => /Relationships in/i.test(s));

    it("documents edge-only relationship authoring", () => {
      expect(edgeGuidance).toBeDefined();
      expect(edgeGuidance).toMatch(/attributed_to/);
      expect(edgeGuidance).toMatch(/has_parent/);
      expect(edgeGuidance).toMatch(/retiring the old edge and adding the new one/i);
      expect(guidanceSummaries.filter((s) => /Relationships in/i.test(s))).toHaveLength(1);
    });
  });

  describe("membership probabilistic gate", () => {
    const gate = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.spec.includes("process") &&
        r.predicate.spec.includes("belongs"),
    );

    it("exists and fires on the process-content node types but not Rule", () => {
      expect(gate?.predicate?.kind).toBe("probabilistic");
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(expect.arrayContaining(["action", "decision", "eval", "reference"]));
      expect(types).not.toContain("rule");
      expect(types).not.toContain("intent");
    });

    it("exempts State — milestone States are structural flow nodes, not membership candidates", () => {
      // A lone terminal/initial State reads like a bare state-machine stage,
      // so semantic membership-checking it warned on the very States the
      // template requires. State quality is governed by the milestone-naming
      // policy instead.
      if (gate?.predicate?.kind !== "probabilistic") return;
      expect(gate.predicate.when_node_type ?? []).not.toContain("state");
    });

    it("softens the atomic-activity grain check to a warning (LLM-judged, non-blocking)", () => {
      const atomic = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          /single business activity/i.test(r.predicate.spec),
      );
      expect(atomic?.on_violation).toBe("warn");
    });
  });

  describe("queued and active are held to identical rules", () => {
    // A `queued` node asserts readiness, so promotion to `queued` is gated by
    // exactly the same policies as activation: no business-process policy may
    // fire on one committed stage without the other. Policies with no
    // lifecycle filter fire on every stage and satisfy this trivially. This
    // locks in BUSINESS_PROCESS_COMMITTED_LIFECYCLES and guards against a
    // future `["active"]`-only (or `["queued"]`-only) policy slipping in.
    it("no policy gates one committed stage without the other", () => {
      for (const p of template.policies) {
        const lifecycles = p.fires_when_node_lifecycle;
        if (!lifecycles) continue;
        const firesQueued = lifecycles.includes("queued");
        const firesActive = lifecycles.includes("active");
        expect(
          firesQueued,
          `policy "${(p.policy ?? `[${p.predicate?.kind}]`).slice(0, 72)}…" fires on queued=${firesQueued} / active=${firesActive}; the two committed stages must be gated identically`,
        ).toBe(firesActive);
      }
    });
  });
});

describe("github-pull-requests template", () => {
  it("is registered and findable by handle", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template).toBeDefined();
    expect(template?.name).toBe("github-pull-requests");
  });

  it("has a non-empty label and description", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.label).toBeTruthy();
    expect(template?.description).toBeTruthy();
    expect(template?.description.length).toBeGreaterThan(10);
  });

  it("ships with an empty policies array (no authoring constraints)", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.policies).toEqual([]);
  });

  it("defaults the Doco overview to the Pull requests perspective", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.perspectives).toEqual([{ slug: "pull-requests", isDefault: true }]);
  });
});

describe("edge-type allowlists (requires_edge_type)", () => {
  // The edge analogue of the node-type allowlist: each template declares which
  // relationship edge types it permits, enforced (block) on edge creation.
  function allowlistOf(name: string): string[] | undefined {
    const t = findDocoTemplateByName(name);
    const p = t?.policies.find((r) => r.predicate?.kind === "requires_edge_type");
    return p?.predicate?.kind === "requires_edge_type" ? [...p.predicate.edge_types] : undefined;
  }

  it("process allows BPMN edge types incl. has_parent (process membership) and bars relates_to", () => {
    const a = allowlistOf("process");
    expect(a && new Set(a)).toEqual(
      new Set([
        "flows_to",
        "has_parent",
        "supports",
        "attributed_to",
        "constrained_by",
        "replaces",
        "derived_from",
      ]),
    );
    expect(a).toContain("has_parent");
    expect(a).not.toContain("relates_to");
  });

  it("seeds as a blocking deterministic policy carrying the edge_types allowlist", () => {
    const template = findDocoTemplateByName("process");
    const policy = template?.policies.find((r) => r.predicate?.kind === "requires_edge_type");
    if (!policy) throw new Error("process requires_edge_type policy missing");
    const seeded = templatePolicyToPolicyRow(policy);
    expect(seeded.kind).toBe("deterministic");
    expect(seeded.on_violation).toBe("block");
    expect(seeded.predicate.sub_kind).toBe("requires_edge_type");
    expect(seeded.predicate.edge_types).toContain("flows_to");
  });
});
