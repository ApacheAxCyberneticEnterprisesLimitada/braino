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
        r.predicate.when_node_type?.includes("reference") &&
        /belongs in glossaries/i.test(r.predicate.spec),
    );

    it("allows only glossary content node types — term entries are References, not Decisions", () => {
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(["eval", "reference", "rule"].sort());
      expect(allowlist.node_types).not.toContain("decision" as never);
    });

    it("does not list Doco policy metadata as glossary content", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      expect(allowlist.node_types).not.toContain("guidance_policy" as never);
      expect(allowlist.node_types).not.toContain("node_authoring_policy" as never);
    });

    it("excludes activity, event, structure, decision, and idea nodes", () => {
      if (allowlist?.kind !== "requires_node_type") throw new Error("allowlist missing");
      for (const t of ["intent", "action", "log", "principal", "state", "idea", "decision"]) {
        expect(allowlist.node_types).not.toContain(t as never);
      }
    });

    it("describes only glossary graph nodes, not Doco policy metadata", () => {
      expect(allowlistPolicy).toMatch(/Only Reference, Rule, and Eval/i);
      expect(allowlistPolicy).toMatch(/Term entries are References/i);
      expect(allowlistPolicy).not.toMatch(/guidance_policy|node_authoring_policy|policy records/i);
    });

    it("runs the semantic membership judge over References, Rules, and Evals (not Decisions or Intents)", () => {
      expect(membershipPolicy?.predicate?.kind).toBe("probabilistic");
      if (membershipPolicy?.predicate?.kind !== "probabilistic") return;
      expect(membershipPolicy.predicate.when_node_type).toEqual(["reference", "rule", "eval"]);
    });
  });

  describe("term entry References", () => {
    const termQuality = template.policies.find(
      (r) =>
        r.predicate?.kind === "probabilistic" &&
        r.predicate.when_node_type?.includes("reference") &&
        /ONE CONCEPT/i.test(r.predicate.spec),
    );
    const guidance = template.policies
      .filter((r) => !r.predicate)
      .map((r) => r.policy ?? "")
      .join("\n");

    it("judges term-entry References (not Decisions) and warns rather than blocks", () => {
      expect(termQuality?.predicate?.kind).toBe("probabilistic");
      if (termQuality?.predicate?.kind !== "probabilistic") return;
      expect(termQuality.predicate.when_node_type).toEqual(["reference"]);
      expect(termQuality.on_violation).toBe("warn");
      expect(termQuality.fires_when_node_lifecycle).toEqual(["active"]);
    });

    it("checks that the prose is the bare term and the definition lives in the attributes", () => {
      const spec =
        termQuality?.predicate?.kind === "probabilistic" ? termQuality.predicate.spec : "";
      // The two checks this revamp is built around.
      expect(spec).toMatch(/PROSE IS THE TERM/i);
      expect(spec).toMatch(/bare word or phrase being defined/i);
      expect(spec).toMatch(/definition belongs in the `definition` attribute, NOT in the prose/i);
      expect(spec).toMatch(/DEFINITION IN ATTRIBUTES/i);
      expect(spec).toMatch(/the `definition` field \(or another attribute/i);
      // A pure cited source is out of scope for the term-entry judge.
      expect(spec).toMatch(/cited external source.*OUT OF SCOPE/is);
    });

    it("does NOT mention the dropped Decision fields (`chosen` / `question`)", () => {
      const spec =
        termQuality?.predicate?.kind === "probabilistic" ? termQuality.predicate.spec : "";
      expect(spec).not.toMatch(/`chosen`/);
      expect(spec).not.toMatch(/`question`/);
    });

    it("documents the term-entry model in guidance: word in prose, meaning in `definition`", () => {
      expect(guidance).toMatch(/A glossary term entry is a Reference/i);
      expect(guidance).toMatch(/word being defined/i);
      expect(guidance).toMatch(/`definition` attribute, never in the prose/i);
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

    it("documents retired-term replacement links on term References", () => {
      expect(guidance).toMatch(/Retired glossary term References/i);
      expect(guidance).toMatch(/`replaces` edge/i);
      expect(guidance).toMatch(/historical docs, UI, tickets, APIs, or code/i);
      expect(guidance).not.toMatch(/superseded_by/i);
    });

    it("aligns the replacement link with the simplified edge vocabulary", () => {
      const replacement = guidance
        .split("\n")
        .find(
          (line) => /Retired glossary term References/i.test(line) && /`replaces` edge/.test(line),
        );
      expect(replacement).toBeDefined();
      expect(replacement).toMatch(/retiring the old edge and adding a new one/i);
    });
  });

  describe("quality gates", () => {
    const specs = template.policies
      .map((r) => (r.predicate?.kind === "probabilistic" ? r.predicate.spec : null))
      .filter((s): s is string => s !== null);
    const summaries = template.policies.map((r) => r.policy ?? "");
    const haystack = [...specs, ...summaries].join("\n");

    it("keeps one concept per glossary term entry", () => {
      expect(haystack).toMatch(/one concept/i);
      expect(haystack).toMatch(/multiple independent terms/i);
    });

    it("requires the definition to include scope plus example or non-example", () => {
      expect(haystack).toMatch(/concise definition/i);
      expect(haystack).toMatch(/product or domain scope/i);
      expect(haystack).toMatch(/example or non-example/i);
    });

    it("handles acronyms and abbreviations explicitly, scoped to the headword", () => {
      expect(haystack).toMatch(/Acronyms and abbreviations/i);
      expect(haystack).toMatch(/expands it/i);
      expect(haystack).toMatch(/short form/i);
      expect(haystack).toMatch(/only inspect the headword/i);
    });

    it("asks borrowed or standards-based terms to cite sources", () => {
      expect(haystack).toMatch(/Borrowed, standards-based, or industry terms/i);
      expect(haystack).toMatch(/Reference/i);
      expect(haystack).toMatch(/product-specific/i);
    });

    it("rejects circular definitions that merely restate the headword", () => {
      expect(haystack).toMatch(/circular/i);
      expect(haystack).toMatch(/restate|restatement|restates/i);
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
        /how_to_run/i.test(r.predicate.spec),
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
      .map((r) => r.policy ?? "")
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
