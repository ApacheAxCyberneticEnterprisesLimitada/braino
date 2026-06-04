import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

describe("glossaries template", () => {
  const template = findDocoTemplateByName("glossaries");
  if (!template) throw new Error("glossaries template not registered");

  it("is registered in DEFAULT_DOCO_TEMPLATES under its plain handle", () => {
    expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === "glossaries")).toBeDefined();
  });

  it("is reachable via its bare handle and is NOT reachable via the legacy hashtag-prefixed form", () => {
    const bare = findDocoTemplateByName("glossaries");
    const hashtagged = findDocoTemplateByName("#glossaries");
    expect(bare).toBeDefined();
    expect(bare?.name).toBe("glossaries");
    expect(hashtagged).toBeUndefined();
  });

  it("has the expected metadata (icon, label, defaultNodeLifecycle)", () => {
    expect(template.icon).toBe("📚");
    expect(template.label).toBe("Glossaries");
    // A glossary term is definitional and complete-on-creation, so it
    // lands `active` (no drafting default); the term-completeness
    // gates apply right away. Stub a term with explicit `drafting`.
    expect(template.defaultNodeLifecycle).toBeUndefined();
    expect(template.description).toMatch(/terminology/i);
    expect(template.description).toMatch(/canonical terms/i);
  });

  it("ships the dictionary-styled Glossary perspective as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "glossary", isDefault: true }]);
  });

  describe("node-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.predicate;
    const allowlistPolicy = template.policies.find(
      (r) => r.predicate?.kind === "requires_node_type",
    )?.policy;
    const membershipPolicy = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("decision") &&
        /belongs in glossaries/i.test(r.policy),
    );

    it("allows only glossary content node types", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(
        ["decision", "eval", "reference", "rule"].sort(),
      );
    });

    it("does not list Doco policy metadata as glossary content", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("guidance_policy" as never);
      expect(allowlist.node_types).not.toContain("node_authoring_policy" as never);
    });

    it("excludes activity, event, structure, and idea nodes", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      for (const t of ["intent", "action", "log", "principal", "state", "idea"]) {
        expect(allowlist.node_types).not.toContain(t as never);
      }
    });

    it("describes only glossary graph nodes, not Doco policy metadata", () => {
      expect(allowlistPolicy).toMatch(/Only Decision, Rule, Reference, and Eval/i);
      expect(allowlistPolicy).not.toMatch(/guidance_policy|node_authoring_policy|policy records/i);
    });

    it("does not run the semantic membership judge against Intents", () => {
      expect(membershipPolicy?.predicate?.kind).toBe("probabilistic");
      if (membershipPolicy?.predicate?.kind !== "probabilistic") return;
      expect(membershipPolicy.predicate.when_node_type).toEqual([
        "decision",
        "rule",
        "reference",
        "eval",
      ]);
    });
  });

  describe("active term Decisions", () => {
    const requiredFields = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.when_node_type?.includes("decision") &&
        r.predicate.fields.includes("question") &&
        r.predicate.fields.includes("chosen"),
    );
    const uniqueCanonicalTerm = template.policies.find((r) => r.predicate?.kind === "unique_field");
    const guidance = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy)
      .join("\n");

    it("requires the concept question and canonical term only when active (no owner required)", () => {
      expect(requiredFields?.predicate?.kind).toBe("requires_field");
      if (requiredFields?.predicate?.kind !== "requires_field") return;
      expect(requiredFields.predicate.fields).toEqual(["question", "chosen"]);
      expect(requiredFields.predicate.fields).not.toContain("decided_by");
      expect(requiredFields.fires_when_node_lifecycle).toEqual(["active"]);
    });

    it("enforces case-folded uniqueness for the canonical term in `chosen`", () => {
      expect(uniqueCanonicalTerm?.predicate?.kind).toBe("unique_field");
      if (uniqueCanonicalTerm?.predicate?.kind !== "unique_field") return;
      expect(uniqueCanonicalTerm.predicate.field).toBe("chosen");
      expect(uniqueCanonicalTerm.predicate.case_fold).toBe(true);
      expect(uniqueCanonicalTerm.predicate.when_node_type).toEqual(["decision"]);
      expect(uniqueCanonicalTerm.fires_when_node_lifecycle).toEqual(["active"]);
    });

    it("documents that alternatives are optional unless real aliases or rejected labels exist", () => {
      expect(guidance).toMatch(/alternatives/i);
      expect(guidance).toMatch(/alias/i);
      expect(guidance).toMatch(/synonym/i);
      expect(guidance).toMatch(/rejected labels/i);
      expect(guidance).toMatch(/omit `alternatives` rather than inventing filler/i);
    });

    it("keeps deprecated and historical terms out of `alternatives` guidance", () => {
      const alternatives = guidance
        .split("\n")
        .find((line) => /`alternatives`/i.test(line) && /inventing filler/i.test(line));
      expect(alternatives).toBeDefined();
      expect(alternatives).not.toMatch(/deprecated|historical/i);
    });

    it("documents retired-term replacement links", () => {
      expect(guidance).toMatch(/Retired glossary Decisions/i);
      expect(guidance).toMatch(/`replaces` edge/i);
      expect(guidance).toMatch(/historical docs, UI, tickets, APIs, or code/i);
      expect(guidance).not.toMatch(/superseded_by/i);
    });

    it("aligns the replacement link with the simplified edge vocabulary", () => {
      const replacement = guidance
        .split("\n")
        .find((line) => /Retired glossary Decisions/i.test(line) && /`replaces` edge/.test(line));
      expect(replacement).toBeDefined();
      expect(replacement).toMatch(/retiring the old edge and adding a new one/i);
    });
  });

  describe("quality gates", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy);
    const haystack = [...specs, ...summaries].join("\n");

    it("keeps one concept per glossary Decision", () => {
      expect(haystack).toMatch(/one concept/i);
      expect(haystack).toMatch(/multiple independent terms/i);
    });

    it("requires active definitions to include scope plus example or non-example", () => {
      expect(haystack).toMatch(/concise definition/i);
      expect(haystack).toMatch(/product or domain scope/i);
      expect(haystack).toMatch(/example or non-example/i);
    });

    it("handles acronyms and abbreviations explicitly", () => {
      expect(haystack).toMatch(/Acronyms and abbreviations/i);
      expect(haystack).toMatch(/expanded/i);
      expect(haystack).toMatch(/short form/i);
    });

    it("asks borrowed or standards-based terms to cite sources", () => {
      expect(haystack).toMatch(/Borrowed, standards-based, or industry terms/i);
      expect(haystack).toMatch(/Reference/i);
      expect(haystack).toMatch(/product-specific/i);
    });

    it("rejects circular definitions that merely restate the headword", () => {
      expect(haystack).toMatch(/circular/i);
      expect(haystack).toMatch(/restate|restatement/i);
    });
  });

  describe("active terminology Evals", () => {
    const evalTarget = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_edge" &&
        r.predicate.when_node_type?.includes("eval") &&
        r.predicate.edge_type === "supports",
    );
    const evalFields = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.when_node_type?.includes("eval") &&
        r.predicate.fields.includes("how_to_run"),
    );
    const rerunRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("eval") &&
        /how_to_run/i.test(r.policy),
    );

    it("requires a supports edge and how_to_run only when active", () => {
      expect(evalTarget?.predicate?.kind).toBe("requires_edge");
      expect(evalTarget?.fires_when_node_lifecycle).toEqual(["active"]);
      expect(evalFields?.predicate?.kind).toBe("requires_field");
      if (evalFields?.predicate?.kind !== "requires_field") return;
      expect(evalFields.predicate.fields).toEqual(["how_to_run"]);
      expect(evalFields.fires_when_node_lifecycle).toEqual(["active"]);
    });

    it("requires reproducible terminology checks", () => {
      expect(rerunRule).toBeDefined();
      expect(rerunRule?.fires_when_node_lifecycle).toEqual(["active"]);
      expect(rerunRule?.predicate?.kind).toBe("probabilistic");
      if (rerunRule?.predicate?.kind !== "probabilistic") return;
      expect(rerunRule.predicate.spec).toMatch(/concrete rerun path/i);
      expect(rerunRule.predicate.spec).toMatch(/search query|URL|script|manual review/i);
    });
  });

  describe("edge vocabulary and the two-stage lifecycle", () => {
    const guidance = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy)
      .join("\n");

    it("frames the glossary as a deliberate two-stage (active/retired) reference work", () => {
      expect(guidance).toMatch(/reference work/i);
      expect(guidance).toMatch(/canonical answer/i);
      // The `queued` stage is explicitly out of scope for a glossary — a term
      // is the canonical answer or it isn't.
      expect(guidance).toMatch(/`queued` stage has no glossary meaning/i);
    });

    it("does NOT default new terms to a non-active lifecycle (no propose/queue dance)", () => {
      expect(template.defaultNodeLifecycle).toBeUndefined();
    });

    it("only ever gates a term on the `active` stage — never `queued` or `drafting`", () => {
      const gated = template.policies.filter((r) => r.fires_when_node_lifecycle);
      expect(gated.length).toBeGreaterThan(0);
      for (const r of gated) {
        expect(r.fires_when_node_lifecycle).toEqual(["active"]);
      }
    });

    it("names `derived_from` as the source-citation edge for borrowed terms", () => {
      const borrowed = guidance
        .split("\n")
        .find((line) => /Borrowed, standards-based, or industry terms/i.test(line));
      expect(borrowed).toBeDefined();
      expect(borrowed).toMatch(/`derived_from` edge/i);
      expect(borrowed).toMatch(/Reference/i);
    });

    it('frames `relates_to` as the associative "see also" link', () => {
      const relates = guidance.split("\n").find((line) => /`relates_to` edges/i.test(line));
      expect(relates).toBeDefined();
      expect(relates).toMatch(/associative/i);
      expect(relates).toMatch(/see also/i);
      expect(relates).toMatch(/broader or narrower/i);
    });

    it("points agents at the authoring-contract and changeset API", () => {
      expect(guidance).toMatch(/authoring-contract\.json/);
      expect(guidance).toMatch(/changesets\.json/);
    });
  });
});
