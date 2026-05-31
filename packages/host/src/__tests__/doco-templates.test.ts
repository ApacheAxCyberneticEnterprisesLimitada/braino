import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("template policies carry no vestigial rule `kind`", () => {
  // Rules are no longer guidances: the guidance/authoring distinction
  // lives in standalone policies (guidance_policies / node_authoring_policies),
  // seeded purely by predicate-presence — never a `kind` field
  // (decision_01KRRR5BQ16ASY8HQEE0V499YG). Keep the vestige out for good.
  it("no seeded template policy declares a `kind`", () => {
    for (const t of DEFAULT_DOCO_TEMPLATES) {
      for (const p of t.policies) {
        expect(p).not.toHaveProperty("kind");
      }
    }
  });
});

describe("business-processes template", () => {
  const template = findDocoTemplateByName("business-processes");
  if (!template) throw new Error("business-processes template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "business-processes")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("business-processes");
    const hashtagged = findDocoTemplateByName("#business-processes");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("business-processes");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("🏭");
    expect(template.label).toBe("business-processes");
    expect(template.defaultNodeLifecycle).toBe("drafting");
    expect(template.description).toMatch(/repeatable business processes/i);
    expect(template.description).toMatch(/BPMN/);
  });

  it("does NOT set the policy-only `allowedNodeTypes` field — that's reserved for `global`", () => {
    expect(template.allowedNodeTypes).toBeUndefined();
  });

  it("ships with the BPMN perspective attached as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "bpmn", isDefault: true }]);
  });

  describe("entity-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_entity_type",
    )?.predicate;

    it("includes the eight process node types plus the Doco's own policy types", () => {
      expect(allowlist?.kind).toBe("requires_entity_type");
      if (allowlist?.kind !== "requires_entity_type") return;
      expect([...allowlist.entity_types].sort()).toEqual(
        [
          "action",
          "decision",
          "eval",
          "guidance_policy",
          "intent",
          "node_authoring_policy",
          "principal",
          "reference",
          "rule",
          "state",
        ].sort(),
      );
    });

    it("admits in-Doco policy authoring (guidance_policy / node_authoring_policy)", () => {
      if (allowlist?.kind !== "requires_entity_type") throw new Error("allowlist missing");
      expect(allowlist.entity_types).toContain("guidance_policy");
      expect(allowlist.entity_types).toContain("node_authoring_policy");
    });

    it("excludes Log and Idea (Logs live in a sibling Doco; Ideas live in their own home)", () => {
      if (allowlist?.kind !== "requires_entity_type") throw new Error("allowlist missing");
      expect(allowlist.entity_types).not.toContain("log");
      expect(allowlist.entity_types).not.toContain("idea");
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

    it("`actor_id` on Action", () => {
      expect(requiresField("actor_id", "action")).toBeDefined();
    });
    it("`target_ref` on Eval", () => {
      expect(requiresField("target_ref", "eval")).toBeDefined();
    });

    it("does not require duplicated process metadata or handoff fields", () => {
      expect(requiresField("actors", "intent")).toBeUndefined();
      expect(requiresField("stakeholders", "intent")).toBeUndefined();
      expect(requiresField("inputs", "action")).toBeUndefined();
      expect(requiresField("outputs", "action")).toBeUndefined();
    });

    it("fires required fields only when the authored node is active", () => {
      for (const [field, entityType] of [
        ["actor_id", "action"],
        ["target_ref", "eval"],
      ]) {
        expect(requiresField(field, entityType)?.fires_when_node_lifecycle).toEqual(["asserted"]);
      }
    });
  });

  describe("requires_edge rules", () => {
    function requiresEdge(edgeType: string, target: string, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge" &&
          r.predicate.edge_type === edgeType &&
          r.predicate.target_node_type === target &&
          r.predicate.when_node_type?.includes(on as never),
      );
    }

    it("Action serves Intent", () => {
      expect(requiresEdge("serves", "intent", "action")).toBeDefined();
    });
    it("Decision serves Intent", () => {
      expect(requiresEdge("serves", "intent", "decision")).toBeDefined();
    });
    it("State serves Intent", () => {
      expect(requiresEdge("serves", "intent", "state")).toBeDefined();
    });

    it("fires flow membership checks only when the node is asserted", () => {
      expect(requiresEdge("serves", "intent", "action")?.fires_when_node_lifecycle).toEqual([
        "asserted",
      ]);
      expect(requiresEdge("serves", "intent", "decision")?.fires_when_node_lifecycle).toEqual([
        "asserted",
      ]);
      expect(requiresEdge("serves", "intent", "state")?.fires_when_node_lifecycle).toEqual([
        "asserted",
      ]);
    });
  });

  describe("actor_id principal resolution", () => {
    const rule = template.policies.find(
      (r) => r.predicate?.kind === "requires_field_resolves_to_principal",
    );

    it("constrains `actor_id` on Actions", () => {
      expect(rule?.predicate?.kind).toBe("requires_field_resolves_to_principal");
      if (rule?.predicate?.kind !== "requires_field_resolves_to_principal") return;
      expect(rule.predicate.field).toBe("actor_id");
      expect(rule.predicate.when_node_type).toContain("action");
      expect(rule.fires_when_node_lifecycle).toEqual(["asserted"]);
    });

    // Post-rename: `allowed_principal_types` removed from the predicate.
    // Principals no longer carry a `type` field (person/agent moved to
    // User). The predicate simply enforces that the field
    // resolves to an existing Principal — the test below now asserts the
    // shape stays minimal.
    it("predicate carries only field + when_node_type after the rename", () => {
      if (rule?.predicate?.kind !== "requires_field_resolves_to_principal") return;
      expect(Object.keys(rule.predicate).sort()).toEqual(["field", "kind", "when_node_type"]);
    });
  });

  describe("Principal lane shape", () => {
    const principalRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("principal") &&
        /swim-lane actors/i.test(r.policy),
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
    // Aggregate predicates that originally encoded these rules ship as
    // guidance until the evaluator can express them directly. The tests
    // below match the guidance summaries' shape rather than predicate kinds.
    const guidanceSummaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy);

    it("State uniqueness within the process is documented", () => {
      expect(guidanceSummaries.some((s) => /\bstate\b.*\bunique\b/i.test(s))).toBe(true);
    });
    it("≥1 active initial State is documented", () => {
      expect(guidanceSummaries.some((s) => /\binitial\b/i.test(s) && /≥1|at least/i.test(s))).toBe(
        true,
      );
    });
    it("≥1 active terminal State is documented", () => {
      expect(guidanceSummaries.some((s) => /\bterminal\b/i.test(s) && /≥1|at least/i.test(s))).toBe(
        true,
      );
    });
    it("Terminal States have no outgoing sequence flow is documented", () => {
      expect(
        guidanceSummaries.some((s) => /terminal/i.test(s) && /no outgoing.*sequence_to/i.test(s)),
      ).toBe(true);
    });
    it("`sequence_to` locality is documented", () => {
      expect(guidanceSummaries.some((s) => /sequence_to.*same process Intent/i.test(s))).toBe(true);
    });
    it("forward sequence reachability is documented", () => {
      expect(guidanceSummaries.some((s) => /forward `sequence_to`/i.test(s))).toBe(true);
    });
  });

  describe("graph-completeness coverage rule", () => {
    const rule = template.policies.find((r) => r.predicate?.kind === "graph-completeness");

    it("wires Intent.actors → Action.actor_id via `serves`", () => {
      expect(rule?.predicate?.kind).toBe("graph-completeness");
      if (rule?.predicate?.kind !== "graph-completeness") return;
      expect(rule.predicate.list_field).toBe("actors");
      expect(rule.predicate.edge_type).toBe("serves");
      expect(rule.predicate.incoming_node_type).toBe("action");
      expect(rule.predicate.incoming_field_must_match).toBe("actor_id");
      expect(rule.predicate.when_node_type).toContain("intent");
    });

    it("fires only when the Intent is active (drafting Intents can be incomplete)", () => {
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
    });
  });

  describe("probabilistic specs cover process-critical claims", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy);
    const haystack = [...specs, ...summaries].join("\n");

    it("exhaustive gateway / branches", () => {
      expect(/exhaustive|default\/else|enum/i.test(haystack)).toBe(true);
    });
    it("keeps gateway completeness as an activation-time check", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" && /exhaustive outgoing branches/i.test(r.policy),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
    });
    it("keeps Action grain as an activation-time check", () => {
      const rule = template.policies.find(
        (r) => r.predicate?.kind === "probabilistic" && /atomic business activity/i.test(r.policy),
      );
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => !r.predicate);
    const summaries = guidance.map((r) => r.policy);

    it("tells agents to use the authoring contract and changesets", () => {
      expect(
        summaries.some((s) => /authoring-contract\.json/i.test(s) && /changesets\.json/i.test(s)),
      ).toBe(true);
    });
    it("tells agents to use relate_many for gateway siblings", () => {
      expect(summaries.some((s) => /relate_many/i.test(s) && /gateway/i.test(s))).toBe(true);
    });
    it("documents draft-first activation", () => {
      expect(summaries.some((s) => /Drafting nodes/i.test(s) && /asserted/i.test(s))).toBe(true);
    });
    it("Log separation (instances live in a sibling Doco)", () => {
      expect(
        summaries.some(
          (s) => /instance/i.test(s) && /(separate|sibling) doco/i.test(s) && /reference/i.test(s),
        ),
      ).toBe(true);
    });
    it("BPMN sequence flow is forward-only and rendered without reversal", () => {
      expect(summaries.some((s) => /sequence_to/i.test(s) && /source -> target/i.test(s))).toBe(
        true,
      );
    });
  });

  describe("field-authored relations stay cohesive with the managed-edge model", () => {
    // After the node-table collapse dropped the five promoted intra-node FK
    // columns (#694), `actor_id` and `parent_intent_id` are authored as fields
    // but PROJECTED by the capture path into first-class edges
    // (`performed_by` / `has_parent`) — they are no longer "not edges" with "no
    // history". The guidance must describe that model, matching the org-chart
    // template, not the pre-drop promoted-column framing.
    const guidanceSummaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy);
    const pointerGuidance = guidanceSummaries.find(
      (s) => /actor_id/.test(s) && /parent_intent_id/.test(s),
    );

    it("documents that actor_id / parent_intent_id project into first-class edges", () => {
      expect(pointerGuidance).toBeDefined();
      expect(pointerGuidance).toMatch(/performed_by/);
      expect(pointerGuidance).toMatch(/has_parent/);
      expect(pointerGuidance).toMatch(/first-class edge/i);
    });

    it("drops the stale pre-FK-drop framing (not edges / no separate history)", () => {
      expect(pointerGuidance).toBeDefined();
      expect(pointerGuidance).not.toMatch(/not first-class edges/i);
      expect(pointerGuidance).not.toMatch(/no separate lifecycle or history/i);
    });

    it("keeps the still-true facts: no DB foreign key, app-enforced, re-point in place", () => {
      expect(pointerGuidance).toBeDefined();
      expect(pointerGuidance).toMatch(/foreign key|\bFK\b/);
      expect(pointerGuidance).toMatch(/resolves?-to-a-Principal|resolve to an existing Principal/i);
      expect(pointerGuidance).toMatch(/editing the field in place/i);
    });
  });

  describe("membership probabilistic gate", () => {
    const gate = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.spec.includes("business-processes") &&
        r.predicate.spec.includes("belongs"),
    );

    it("exists and fires on the process-content node types but not Rule", () => {
      expect(gate?.predicate?.kind).toBe("probabilistic");
      if (gate?.predicate?.kind !== "probabilistic") return;
      const types = gate.predicate.when_node_type ?? [];
      expect(types).toEqual(
        expect.arrayContaining(["intent", "action", "decision", "eval", "reference"]),
      );
      expect(types).not.toContain("rule");
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
        (r) => r.predicate?.kind === "probabilistic" && /atomic business activity/i.test(r.policy),
      );
      expect(atomic?.on_violation).toBe("warn");
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

  it("does NOT set allowedNodeTypes — PRs are stored as reference nodes, allow all", () => {
    const template = findDocoTemplateByName("github-pull-requests");
    expect(template?.allowedNodeTypes).toBeUndefined();
  });
});
