import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("org-chart template", () => {
  const template = findDocoTemplateByName("org-chart");
  if (!template) throw new Error("org-chart template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "org-chart")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("org-chart");
    const hashtagged = findDocoTemplateByName("#org-chart");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("org-chart");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNeuronLifecycle)", () => {
    expect(template.icon).toBe("🏢");
    expect(template.label).toBe("org-chart");
    expect(template.defaultNeuronLifecycle).toBe("drafting");
    expect(template.description).toMatch(/person/i);
    expect(template.description).toMatch(/AI agent/i);
  });

  it("ships with the org-tree perspective attached as default", () => {
    expect(template.perspectives).toEqual([{ slug: "org-tree", isDefault: true }]);
  });

  it("does NOT set the policy-only `allowedNeuronTypes` field — that's reserved for `global`", () => {
    expect(template.allowedNeuronTypes).toBeUndefined();
  });

  describe("neuron-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_neuron_type",
    )?.predicate;

    it("includes exactly Principal, Intent, Decision, Reference, and Rule", () => {
      expect(allowlist?.kind).toBe("requires_neuron_type");
      if (allowlist?.kind !== "requires_neuron_type") return;
      expect([...allowlist.neuron_types].sort()).toEqual(
        ["decision", "intent", "principal", "reference", "rule"].sort(),
      );
    });

    it("excludes Action, State, Eval, Log, and Idea (those describe activity, not org structure)", () => {
      if (allowlist?.kind !== "requires_neuron_type") throw new Error("allowlist missing");
      for (const t of ["action", "state", "eval", "log", "idea"]) {
        expect(allowlist.neuron_types).not.toContain(t);
      }
    });
  });

  describe("the unique constraint — person-vs-agent declaration", () => {
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.fields.includes("type") &&
        r.predicate.when_neuron_type?.includes("principal"),
    );

    it("exists — every Principal MUST declare `type`", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("requires_field");
    });

    it("fires on every Principal regardless of lifecycle (no fires_when_neuron_lifecycle gate)", () => {
      // A drafting member still needs the kind declared — that's the
      // first thing the org-tree perspective renders.
      expect(rule?.fires_when_neuron_lifecycle).toBeUndefined();
    });

    it("blocks by default — `type` is identity-grade", () => {
      // No on_violation override means the framework default applies
      // (block). The guidance rules below explicitly say flipping
      // `type` requires retiring + re-creating the Principal, so a
      // missing type at write time should hard-fail.
      expect(rule?.on_violation).toBeUndefined();
    });
  });

  describe("hierarchy — reports_to", () => {
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_synapse" &&
        r.predicate.synapse_type === "reports_to" &&
        r.predicate.when_neuron_type?.includes("principal"),
    );

    it("every active Principal must have a `reports_to` synapse to another Principal", () => {
      expect(rule?.predicate?.kind).toBe("requires_synapse");
      if (rule?.predicate?.kind !== "requires_synapse") return;
      expect(rule.predicate.synapse_type).toBe("reports_to");
      expect(rule.predicate.target_neuron_type).toBe("principal");
    });

    it("fires only on `active` — drafting members can be captured before their manager exists", () => {
      expect(rule?.fires_when_neuron_lifecycle).toEqual(["active"]);
    });
  });

  describe("team Intents declare members in `actors`", () => {
    const rule = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.fields.includes("actors") &&
        r.predicate.when_neuron_type?.includes("intent"),
    );

    it("exists", () => {
      expect(rule).toBeDefined();
      expect(rule?.predicate?.kind).toBe("requires_field");
    });
  });

  describe("probabilistic style gates", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.summary);
    const haystack = [...specs, ...summaries].join("\n");

    it("Principal display_name reads as a role or title", () => {
      const styleGate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_neuron_type?.includes("principal") &&
          r.predicate.spec.includes("display_name"),
      );
      expect(styleGate).toBeDefined();
    });

    it("top-of-chain Principal explains the missing reports_to in body_md", () => {
      const topGate = template.policies.find(
        (r) =>
          r.predicate?.kind === "probabilistic" &&
          r.predicate.when_neuron_type?.includes("principal") &&
          /top of (a |the )?reporting chain/i.test(r.predicate.spec),
      );
      expect(topGate).toBeDefined();
      // Soft warn rather than hard block — the active-Principal
      // reports_to requirement above catches missing edges that
      // should exist; this one prompts the root to justify itself.
      expect(topGate?.on_violation).toBe("warn");
    });

    it("references the founder/board/root-agent shapes that legitimately have no manager", () => {
      expect(/founder|board|root agent|external authority/i.test(haystack)).toBe(true);
    });
  });

  describe("guidance rules", () => {
    const guidance = template.policies.filter((r) => r.kind === "guidance" && !r.predicate);
    const summaries = guidance.map((r) => r.summary);

    it("`reports_to` chains must not be circular (engine can't check yet)", () => {
      expect(summaries.some((s) => /reports_to/i.test(s) && /circular|cycle/i.test(s))).toBe(true);
    });

    it("AI-agent Principals declare their human owner (mirrors Collaborator.owner_id)", () => {
      expect(
        summaries.some(
          (s) => /AI(-|\s)?agent/i.test(s) && /(owner|delegated_by|operates under|human)/i.test(s),
        ),
      ).toBe(true);
    });

    it("reorgs / hires / departures captured as Decisions", () => {
      expect(summaries.some((s) => /reorg/i.test(s) && /Decision/i.test(s))).toBe(true);
    });

    it("Intents model teams / departments / units", () => {
      expect(summaries.some((s) => /team/i.test(s) && /Intent/i.test(s))).toBe(true);
    });

    it("`type` is identity — flipping it in place is forbidden, retire and recreate instead", () => {
      expect(
        summaries.some(
          (s) => /retire/i.test(s) && /(type|kind)/i.test(s) && /(new|create|recreate)/i.test(s),
        ),
      ).toBe(true);
    });

    it("person vs agent is about who fills the seat, not about who signed in", () => {
      expect(summaries.some((s) => /seat/i.test(s) && /Collaborator|sign(ed)? in/i.test(s))).toBe(
        true,
      );
    });
  });
});
