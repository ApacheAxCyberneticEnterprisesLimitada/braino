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
    // lands `asserted` (no drafting default); the term-completeness
    // gates apply right away. Stub a term with explicit `drafting`.
    expect(template.defaultNodeLifecycle).toBeUndefined();
    expect(template.description).toMatch(/terminology/i);
    expect(template.description).toMatch(/canonical terms/i);
  });

  it("ships the dictionary-styled Glossary perspective as the default", () => {
    expect(template.perspectives).toEqual([{ slug: "glossary", isDefault: true }]);
  });

  it("does NOT set the policy-only `allowedNodeTypes` field — that's reserved for `global`", () => {
    expect(template.allowedNodeTypes).toBeUndefined();
  });

  describe("entity-type allowlist", () => {
    const allowlist = template.policies.find(
      (r) => r.predicate?.kind === "requires_entity_type",
    )?.predicate;

    it("allows glossary content plus the two policy entity types", () => {
      expect(allowlist?.kind).toBe("requires_entity_type");
      if (allowlist?.kind !== "requires_entity_type") return;
      expect([...allowlist.entity_types].sort()).toEqual(
        [
          "decision",
          "eval",
          "guidance_policy",
          "intent",
          "node_authoring_policy",
          "reference",
          "rule",
        ].sort(),
      );
    });

    it("excludes activity, event, structure, and idea entities", () => {
      if (allowlist?.kind !== "requires_entity_type") throw new Error("allowlist missing");
      for (const t of ["action", "log", "principal", "state", "idea"]) {
        expect(allowlist.entity_types).not.toContain(t);
      }
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
      expect(requiredFields.fires_when_node_lifecycle).toEqual(["asserted"]);
    });

    it("enforces case-folded uniqueness for the canonical term in `chosen`", () => {
      expect(uniqueCanonicalTerm?.predicate?.kind).toBe("unique_field");
      if (uniqueCanonicalTerm?.predicate?.kind !== "unique_field") return;
      expect(uniqueCanonicalTerm.predicate.field).toBe("chosen");
      expect(uniqueCanonicalTerm.predicate.case_fold).toBe(true);
      expect(uniqueCanonicalTerm.predicate.when_node_type).toEqual(["decision"]);
      expect(uniqueCanonicalTerm.fires_when_node_lifecycle).toEqual(["asserted"]);
    });

    it("documents that alternatives are optional unless real alternate names exist", () => {
      expect(guidance).toMatch(/alternatives/i);
      expect(guidance).toMatch(/rejected|deprecated|historical/i);
      expect(guidance).toMatch(/omit `alternatives` rather than inventing filler/i);
    });

    it("documents retired-term replacement links", () => {
      expect(guidance).toMatch(/Retired glossary Decisions/i);
      expect(guidance).toMatch(/superseded_by/i);
    });

    it("aligns the superseded_by replacement link with the first-class-edge, no-FK model", () => {
      // The node-table collapse dropped `superseded_by` as a promoted FK
      // column; the capture path now projects it into a first-class edge with
      // no database foreign key (existence is app-enforced). The glossary
      // guidance must teach that model so a retired term's replacement link
      // reads like org-chart's `reports_to` and business-processes'
      // `sequence_flow` rather than a dangling pointer.
      const supersede = guidance
        .split("\n")
        .find((line) => /Retired glossary Decisions/i.test(line) && /superseded_by/.test(line));
      expect(supersede).toBeDefined();
      expect(supersede).toMatch(/first-class/i);
      expect(supersede).toMatch(/edge/i);
      expect(supersede).toMatch(/foreign key|app-enforced/i);
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
  });

  describe("active terminology Evals", () => {
    const evalFields = template.policies.find(
      (r) =>
        r.predicate?.kind === "requires_field" &&
        r.predicate.when_node_type?.includes("eval") &&
        r.predicate.fields.includes("target_ref") &&
        r.predicate.fields.includes("how_to_run"),
    );
    const rerunRule = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("eval") &&
        /how_to_run/i.test(r.policy),
    );

    it("requires target_ref and how_to_run only when active", () => {
      expect(evalFields?.predicate?.kind).toBe("requires_field");
      if (evalFields?.predicate?.kind !== "requires_field") return;
      expect(evalFields.predicate.fields).toEqual(["target_ref", "how_to_run"]);
      expect(evalFields.fires_when_node_lifecycle).toEqual(["asserted"]);
    });

    it("requires reproducible terminology checks", () => {
      expect(rerunRule).toBeDefined();
      expect(rerunRule?.fires_when_node_lifecycle).toEqual(["asserted"]);
      expect(rerunRule?.predicate?.kind).toBe("probabilistic");
      if (rerunRule?.predicate?.kind !== "probabilistic") return;
      expect(rerunRule.predicate.spec).toMatch(/concrete rerun path/i);
      expect(rerunRule.predicate.spec).toMatch(/search query|URL|script|manual review/i);
    });
  });
});
