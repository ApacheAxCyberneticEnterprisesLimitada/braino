import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("slas template", () => {
  const template = findDocoTemplateByName("slas");
  if (!template) throw new Error("slas template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "slas")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("slas");
    const hashtagged = findDocoTemplateByName("#slas");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("slas");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata and ships the SLA perspective as default", () => {
    expect(template.icon).toBe("📜");
    expect(template.label).toBe("SLAs");
    expect(template.defaultNeuronLifecycle).toBe("drafting");
    expect(template.description).toMatch(/service-level agreements/i);
    expect(template.perspectives).toEqual([{ slug: "sla", isDefault: true }]);
  });

  it("allows agreement/control-plane entities but excludes raw logs, ideas, and states", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_entity_type",
    )?.predicate;
    expect(allowlist?.kind).toBe("requires_entity_type");
    if (allowlist?.kind !== "requires_entity_type") return;

    expect([...allowlist.entity_types].sort()).toEqual(
      [
        "action",
        "decision",
        "eval",
        "guidance_policy",
        "intent",
        "neuron_authoring_policy",
        "principal",
        "reference",
        "rule",
      ].sort(),
    );
    for (const t of ["log", "idea", "state"]) {
      expect(allowlist.entity_types).not.toContain(t);
    }
  });

  it("requires active SLA Rules to carry register fields and an owner Principal", () => {
    const fields = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.when_neuron_type?.includes("rule") &&
        r.predicate.fields.includes("owner_id"),
    );
    const owner = template.policies.find(
      (r) => r.predicate?.kind === "requires_field_resolves_to_principal",
    );
    const sourceRef = template.policies.find(
      (r) => r.predicate?.kind === "requires_synapse" && r.predicate.synapse_type === "source_ref",
    );

    expect(fields?.predicate?.kind).toBe("requires_field");
    if (fields?.predicate?.kind === "requires_field") {
      expect(fields.predicate.fields).toEqual([
        "owner_id",
        "metric",
        "target",
        "measurement_window",
        "source_ref",
      ]);
      expect(fields.fires_when_neuron_lifecycle).toEqual(["asserted"]);
    }
    expect(owner?.predicate?.kind).toBe("requires_field_resolves_to_principal");
    expect(sourceRef?.predicate?.kind).toBe("requires_synapse");
  });

  it("treats the 100% target rationale policy as an active-only warning", () => {
    const noErrorBudget = template.policies.find((r) => /No SLA target is 100%/.test(r.policy));

    expect(noErrorBudget?.predicate?.kind).toBe("probabilistic");
    expect(noErrorBudget?.fires_when_neuron_lifecycle).toEqual(["asserted"]);
    expect(noErrorBudget?.on_violation).toBe("warn");
  });

  it("requires active SLA Evals to point at Rules and be reproducible", () => {
    const evalFields = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.when_neuron_type?.includes("eval") &&
        r.predicate.fields.includes("target_ref"),
    );
    const testsRule = template.policies.find(
      (r) => r.predicate?.kind === "requires_synapse" && r.predicate.synapse_type === "tests",
    );
    const rerun = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_neuron_type?.includes("eval") &&
        /how_to_run/i.test(r.policy),
    );

    expect(evalFields?.fires_when_neuron_lifecycle).toEqual(["asserted"]);
    expect(testsRule?.predicate?.kind).toBe("requires_synapse");
    expect(rerun?.predicate?.kind).toBe("probabilistic");
    if (rerun?.predicate?.kind === "probabilistic") {
      expect(rerun.predicate.spec).toMatch(/numerator/i);
      expect(rerun.predicate.spec).toMatch(/denominator/i);
    }
  });

  it("documents that SLA Docos are not operational event ledgers", () => {
    const guidance = template.policies
      .filter((r) => r.kind === "guidance" && !r.predicate)
      .map((r) => r.policy)
      .join("\n");
    expect(guidance).toMatch(/Do not store raw service-delivery events/i);
    expect(guidance).toMatch(/monitoring\/support\/billing\/contract systems/i);
  });
});
