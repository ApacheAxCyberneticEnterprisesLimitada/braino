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

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;

    it("includes only process node types", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["action", "decision", "eval", "intent", "principal", "reference", "rule", "state"].sort(),
      );
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
        /Only Intent, Action, Decision, State, Eval, Reference, Rule, and Principal/i,
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
    function requiresEdgeRole(edgeType: string, role: string, target: string | null, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_edge_role" &&
          r.predicate.edge_type === edgeType &&
          r.predicate.edge_role === role &&
          (target === null || r.predicate.target_node_type === target) &&
          r.predicate.when_node_type?.includes(on as never),
      );
    }

    it("Action serves Intent", () => {
      expect(requiresEdgeRole("supports", "serves", "intent", "action")).toBeDefined();
    });
    it("Decision serves Intent", () => {
      expect(requiresEdgeRole("supports", "serves", "intent", "decision")).toBeDefined();
    });
    it("State serves Intent", () => {
      expect(requiresEdgeRole("supports", "serves", "intent", "state")).toBeDefined();
    });
    it("Action performed_by Principal", () => {
      expect(
        requiresEdgeRole("attributed_to", "performed_by", "principal", "action"),
      ).toBeDefined();
    });
    it("Eval tests a target", () => {
      const rule = requiresEdgeRole("supports", "tests", null, "eval");
      expect(rule).toBeDefined();
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
    });

    it("fires flow membership checks only when the node is asserted", () => {
      expect(
        requiresEdgeRole("supports", "serves", "intent", "action")?.fires_when_node_lifecycle,
      ).toEqual(["asserted"]);
      expect(
        requiresEdgeRole("supports", "serves", "intent", "decision")?.fires_when_node_lifecycle,
      ).toEqual(["asserted"]);
      expect(
        requiresEdgeRole("supports", "serves", "intent", "state")?.fires_when_node_lifecycle,
      ).toEqual(["asserted"]);
    });

    it("keeps the role vocabulary in the business-process guidance", () => {
      const policies = template.policies.map((r) => r.policy).join("\n");
      expect(policies).toMatch(/`serves`/);
      expect(policies).toMatch(/`performed_by`/);
      expect(policies).toMatch(/`tests`/);
      expect(policies).toMatch(/`gated_by`/);
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
        guidanceSummaries.some((s) => /terminal/i.test(s) && /no outgoing.*flows_to/i.test(s)),
      ).toBe(true);
    });
    it("`flows_to` locality is documented", () => {
      expect(guidanceSummaries.some((s) => /flows_to.*same process Intent/i.test(s))).toBe(true);
    });
    it("forward sequence reachability is documented", () => {
      expect(guidanceSummaries.some((s) => /forward `flows_to`/i.test(s))).toBe(true);
    });
  });

  describe("actor coverage guidance", () => {
    const rule = template.policies.find(
      (r) => r.predicate?.kind === "descriptive" && /actor Principal/i.test(r.policy),
    );

    it("documents performed_by / serves coverage", () => {
      expect(rule?.predicate?.kind).toBe("descriptive");
      if (rule?.predicate?.kind !== "descriptive") return;
      expect(rule.predicate.spec).toMatch(/attributed_to/);
      expect(rule.predicate.spec).toMatch(/performed_by/);
      expect(rule.predicate.spec).toMatch(/supports/);
      expect(rule.predicate.spec).toMatch(/serves/);
      expect(rule.fires_when_node_lifecycle).toEqual(["asserted"]);
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
    it("blocks imported BPMN/source metadata in user-facing process prose", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" && /imported BPMN\/source metadata/i.test(r.policy),
      );
      expect(rule?.on_violation).toBe("block");
      expect(rule?.fires_when_node_lifecycle).toEqual(["asserted"]);
      expect(rule?.predicate?.kind).toBe("probabilistic");
      if (rule?.predicate?.kind !== "probabilistic") return;
      expect(rule.predicate.when_node_type).toEqual(
        expect.arrayContaining(["intent", "action", "decision", "state", "eval", "rule"]),
      );
      expect(rule.predicate.when_node_type).not.toContain("reference");
      expect(rule.predicate.spec).toMatch(/Implementation status/i);
      expect(rule.predicate.spec).toMatch(/Source type/i);
      expect(rule.predicate.spec).toMatch(/exclusiveGateway/i);
      expect(rule.predicate.spec).toMatch(/visible prose/i);
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
      expect(summaries.some((s) => /flows_to/i.test(s) && /source -> target/i.test(s))).toBe(true);
    });
  });

  describe("relationships are edge-only", () => {
    const guidanceSummaries = template.policies.filter((r) => !r.predicate).map((r) => r.policy);
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
