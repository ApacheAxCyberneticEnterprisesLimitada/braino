import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

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

  it("has the expected metadata (icon, label, defaultNeuronLifecycle)", () => {
    expect(template.icon).toBe("🏭");
    expect(template.label).toBe("business-processes");
    expect(template.defaultNeuronLifecycle).toBe("drafting");
    expect(template.description).toMatch(/repeatable business processes/i);
    expect(template.description).toMatch(/BPMN/);
  });

  it("does NOT set the policy-only `allowedNeuronTypes` field — that's reserved for `global`", () => {
    expect(template.allowedNeuronTypes).toBeUndefined();
  });

  describe("neuron-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_neuron_type",
    )?.predicate;

    it("includes the eight allowed types (Intent, Action, Decision, State, Eval, Reference, Rule, Principal)", () => {
      expect(allowlist?.kind).toBe("requires_neuron_type");
      if (allowlist?.kind !== "requires_neuron_type") return;
      expect([...allowlist.neuron_types].sort()).toEqual(
        ["action", "decision", "eval", "intent", "principal", "reference", "rule", "state"].sort(),
      );
    });

    it("excludes Log and Idea (Logs live in a sibling Doco; Ideas live in their own home)", () => {
      if (allowlist?.kind !== "requires_neuron_type") throw new Error("allowlist missing");
      expect(allowlist.neuron_types).not.toContain("log");
      expect(allowlist.neuron_types).not.toContain("idea");
    });
  });

  describe("requires_field rules", () => {
    function requiresField(field: string, entityType: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_field" &&
          r.predicate.fields.includes(field) &&
          r.predicate.when_neuron_type?.includes(entityType as never),
      );
    }

    it("`actors` on Intent", () => {
      expect(requiresField("actors", "intent")).toBeDefined();
    });
    it("`stakeholders` on Intent", () => {
      expect(requiresField("stakeholders", "intent")).toBeDefined();
    });
    it("`actor_id` on Action", () => {
      expect(requiresField("actor_id", "action")).toBeDefined();
    });
    it("`inputs` on Action", () => {
      expect(requiresField("inputs", "action")).toBeDefined();
    });
    it("`outputs` on Action", () => {
      expect(requiresField("outputs", "action")).toBeDefined();
    });
    it("`target_ref` on Eval", () => {
      expect(requiresField("target_ref", "eval")).toBeDefined();
    });
  });

  describe("requires_synapse rules", () => {
    function requiresEdge(synapseType: string, target: string, on: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_synapse" &&
          r.predicate.synapse_type === synapseType &&
          r.predicate.target_neuron_type === target &&
          r.predicate.when_neuron_type?.includes(on as never),
      );
    }

    it("Action serves Intent", () => {
      expect(requiresEdge("serves", "intent", "action")).toBeDefined();
    });
    it("Decision serves Intent", () => {
      expect(requiresEdge("serves", "intent", "decision")).toBeDefined();
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
      expect(rule.predicate.when_neuron_type).toContain("action");
    });

    // Post-rename: `allowed_principal_types` removed from the predicate.
    // Principals no longer carry a `type` field (person/agent moved to
    // Collaborator). The predicate simply enforces that the field
    // resolves to an existing Principal — the test below now asserts the
    // shape stays minimal.
    it("predicate carries only field + when_neuron_type after the rename", () => {
      if (rule?.predicate?.kind !== "requires_field_resolves_to_principal") return;
      expect(Object.keys(rule.predicate).sort()).toEqual(["field", "kind", "when_neuron_type"]);
    });
  });

  describe("State wiring", () => {
    // Aggregate predicates that originally encoded these rules ship as
    // guidance until the evaluator can express them directly. The tests
    // below match the guidance summaries' shape rather than predicate kinds.
    const guidanceSummaries = template.policies
      .filter((r) => r.kind === "guidance" && !r.predicate)
      .map((r) => r.summary);

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
    it("Terminal States have no successor Action is documented", () => {
      expect(
        guidanceSummaries.some((s) => /terminal/i.test(s) && /successor|no.*preceded_by/i.test(s)),
      ).toBe(true);
    });
    it("`preceded_by` locality is documented", () => {
      expect(guidanceSummaries.some((s) => /preceded_by.*same/i.test(s))).toBe(true);
    });
  });

  describe("graph-completeness coverage rule", () => {
    const rule = template.policies.find((r) => r.predicate?.kind === "graph-completeness");

    it("wires Intent.actors → Action.actor_id via `serves`", () => {
      expect(rule?.predicate?.kind).toBe("graph-completeness");
      if (rule?.predicate?.kind !== "graph-completeness") return;
      expect(rule.predicate.list_field).toBe("actors");
      expect(rule.predicate.synapse_type).toBe("serves");
      expect(rule.predicate.incoming_neuron_type).toBe("action");
      expect(rule.predicate.incoming_field_must_match).toBe("actor_id");
      expect(rule.predicate.when_neuron_type).toContain("intent");
    });

    it("fires only when the Intent is active (drafting Intents can be incomplete)", () => {
      expect(rule?.fires_when_neuron_lifecycle).toEqual(["active"]);
    });
  });

  describe("probabilistic specs cover process-critical claims", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.summary);
    const haystack = [...specs, ...summaries].join("\n");

    it("exhaustive gateway / branches", () => {
      expect(/exhaustive|default\/else|enum/i.test(haystack)).toBe(true);
    });
    it("compensation for side-effecting Actions", () => {
      expect(/compensat/i.test(haystack)).toBe(true);
    });
    it("bounded loops", () => {
      expect(/loop|retry|iteration/i.test(haystack)).toBe(true);
    });
    it("timer-driven Actions name anchor + ISO 8601 offset", () => {
      expect(/ISO 8601/i.test(haystack)).toBe(true);
      expect(/anchor/i.test(haystack)).toBe(true);
    });
    it("trust-boundary crossings", () => {
      expect(/trust boundary|trust-boundary|boundary/i.test(haystack)).toBe(true);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => r.kind === "guidance" && !r.predicate);
    const summaries = guidance.map((r) => r.summary);

    it("happy-path-first ordering", () => {
      expect(summaries.some((s) => /happy path first/i.test(s))).toBe(true);
    });
    it("sub-process modeling (reference by Intent, don't inline)", () => {
      expect(summaries.some((s) => /sub-process/i.test(s) && /intent/i.test(s))).toBe(true);
    });
    it("Log separation (instances live in a sibling Doco)", () => {
      expect(
        summaries.some(
          (s) => /instance/i.test(s) && /(separate|sibling) doco/i.test(s) && /reference/i.test(s),
        ),
      ).toBe(true);
    });
    it("explicit handoffs (outputs line up with next consumer's inputs)", () => {
      expect(
        summaries.some((s) => /handoff/i.test(s) && /outputs/i.test(s) && /inputs/i.test(s)),
      ).toBe(true);
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
      const types = gate.predicate.when_neuron_type ?? [];
      expect(types).toEqual(
        expect.arrayContaining(["intent", "action", "decision", "state", "eval", "reference"]),
      );
      expect(types).not.toContain("rule");
    });
  });
});
