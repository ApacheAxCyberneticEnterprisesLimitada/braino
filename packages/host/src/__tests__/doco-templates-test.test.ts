import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("test template", () => {
  const template = findDocoTemplateByName("test");
  if (!template) throw new Error("test template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "test")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("test");
    const hashtagged = findDocoTemplateByName("#test");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("test");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNeuronLifecycle)", () => {
    expect(template.icon).toBe("🧪");
    expect(template.label).toBe("Tests");
    expect(template.defaultNeuronLifecycle).toBe("drafting");
    expect(template.description).toMatch(/executable tests/i);
    expect(template.description).toMatch(/AI evals/i);
  });

  it("does NOT set the policy-only `allowedNeuronTypes` field — that's reserved for `global`", () => {
    expect(template.allowedNeuronTypes).toBeUndefined();
  });

  it("does not attach a custom perspective by default", () => {
    expect(template.perspectives).toBeUndefined();
  });

  describe("entity-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_entity_type",
    )?.predicate;

    it("allows Eval plus the two policy entity types", () => {
      expect(allowlist?.kind).toBe("requires_entity_type");
      if (allowlist?.kind !== "requires_entity_type") return;
      expect([...allowlist.entity_types].sort()).toEqual(
        ["eval", "guidance_policy", "neuron_authoring_policy"].sort(),
      );
    });

    it("excludes ordinary domain neurons", () => {
      if (allowlist?.kind !== "requires_entity_type") throw new Error("allowlist missing");
      for (const t of ["action", "decision", "intent", "log", "principal", "state"]) {
        expect(allowlist.entity_types).not.toContain(t);
      }
    });
  });

  describe("required Eval fields", () => {
    function requiresField(field: string) {
      return template.policies.find(
        (r) =>
          r.predicate?.kind === "requires_field" &&
          r.predicate.fields.includes(field) &&
          r.predicate.when_neuron_type?.includes("eval"),
      );
    }

    it("requires `eval`, `criterion`, and `kind` from creation", () => {
      expect(requiresField("eval")).toBeDefined();
      expect(requiresField("criterion")).toBeDefined();
      expect(requiresField("kind")).toBeDefined();
    });

    it("requires `target_ref` only when the Eval is active", () => {
      expect(requiresField("target_ref")?.fires_when_neuron_lifecycle).toEqual(["accepted"]);
    });

    it("requires `how_to_run` only when the Eval is active", () => {
      expect(requiresField("how_to_run")?.fires_when_neuron_lifecycle).toEqual(["accepted"]);
    });
  });

  describe("probabilistic quality gates", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy);
    const haystack = [...specs, ...summaries].join("\n");

    it("keeps the Eval label as a checkable property, not a serial label", () => {
      expect(haystack).toMatch(/checkable property/i);
      expect(haystack).toMatch(/test 1|eval A|it works/i);
    });

    it("asks authors to split independent claims", () => {
      expect(haystack).toMatch(/one property/i);
      expect(haystack).toMatch(/split candidate/i);
    });

    it("distinguishes concrete exact/shape expectations from llm-judge prose", () => {
      expect(haystack).toMatch(/exact.*shape.*concrete top-level Eval `expected`/i);
      expect(haystack).toMatch(/Do not require `expected` inside the `criterion` object/i);
      expect(haystack).toMatch(/llm-judge/i);
      expect(haystack).toMatch(/Vague or subjective/i);
    });

    it("requires active `how_to_run` to be genuinely reproducible", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_neuron_type?.includes("eval") &&
          /how_to_run/i.test(r.policy),
      );
      expect(rule).toBeDefined();
      expect(rule?.fires_when_neuron_lifecycle).toEqual(["accepted"]);
      expect(rule?.predicate?.kind).toBe("probabilistic");
      if (rule?.predicate?.kind !== "probabilistic") return;
      expect(rule.predicate.spec).toMatch(/concrete rerun path/i);
      expect(rule.predicate.spec).toMatch(/vague/i);
    });

    it("requires a recognizable test oracle", () => {
      const rule = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_neuron_type?.includes("eval") &&
          /test oracle/i.test(r.policy),
      );
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("probabilistic");
      if (rule?.predicate?.kind !== "probabilistic") return;
      expect(rule.predicate.spec).toMatch(/evidence/i);
      expect(rule.predicate.spec).toMatch(/actual/i);
      expect(rule.predicate.spec).toMatch(/top-level `expected`/i);
      expect(rule.predicate.spec).toMatch(/pass\/fail boundary/i);
      expect(rule.predicate.spec).toMatch(/works|matches requirements/i);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => r.kind === "guidance" && !r.predicate);
    const summaries = guidance.map((r) => r.policy);
    const haystack = summaries.join("\n");

    it("supports TDD-style fail-first evals", () => {
      expect(haystack).toMatch(/expected_status: "fail"/);
      expect(haystack).toMatch(/regression guard/i);
    });

    it("keeps regression evals durable", () => {
      expect(haystack).toMatch(/regression eval/i);
      expect(haystack).toMatch(/Removing it requires a Decision/i);
    });

    it("prefers the smallest effective check in the test pyramid", () => {
      expect(haystack).toMatch(/test-pyramid/i);
      expect(haystack).toMatch(/smallest effective check/i);
      expect(haystack).toMatch(/unit or integration Eval/i);
      expect(haystack).toMatch(/llm-judge/i);
    });

    it("allows BDD or AAA phrasing without bundling multiple behaviors", () => {
      expect(haystack).toMatch(/Given\/When\/Then/i);
      expect(haystack).toMatch(/Arrange\/Act\/Assert/i);
      expect(haystack).toMatch(/one behavior per Eval/i);
    });

    it("models run history as Logs and treats stale passes as unknown", () => {
      expect(haystack).toMatch(/Log per run/i);
      expect(haystack).toMatch(/stale|long ago|re-run/i);
    });

    it("does not normalize flaky evals as green", () => {
      expect(haystack).toMatch(/flaky Eval is not green/i);
      expect(haystack).toMatch(/Record every outcome as a Log/i);
      expect(haystack).toMatch(/retire the Eval with a Decision/i);
    });

    it("prefers repo-native automated tests when they can exist", () => {
      expect(haystack).toMatch(/repo-native automated test/i);
      expect(haystack).toMatch(/not a replacement for executable test code/i);
    });

    it("keeps large fixtures out of inline Eval fields", () => {
      expect(haystack).toMatch(/Large fixtures/i);
      expect(haystack).toMatch(/References or repo artifacts/i);
    });

    it("pins targets in the same doco until imports exist", () => {
      expect(haystack).toMatch(/target_ref/i);
      expect(haystack).toMatch(/own doco|same doco/i);
      expect(haystack).toMatch(/imports machinery/i);
    });
  });
});
