import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

const DECISION_RECORD_HANDLES = [
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "data-decisions",
] as const;

const DECISION_RECORD_NODE_TYPES = [
  "decision",
  "eval",
  "intent",
  "principal",
  "reference",
  "rule",
].sort();

function template(handle: (typeof DECISION_RECORD_HANDLES)[number]) {
  const found = findDocoTemplateByName(handle);
  if (!found) throw new Error(`${handle} template not registered`);
  return found;
}

describe("decision-record templates", () => {
  it("registers all four decision-record templates under plain handles", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const found = findDocoTemplateByName(handle);
      expect(found?.name).toBe(handle);
      expect(DEFAULT_DOCO_TEMPLATES.find((t) => t.name === handle)).toBeDefined();
      expect(findDocoTemplateByName(`#${handle}`)).toBeUndefined();
    }
  });

  it("defaults the templates to the built-in list perspective without lifecycle overrides", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const t = template(handle);
      expect(t.perspectives).toEqual([{ slug: "list", isDefault: true }]);
      expect(t.defaultNodeLifecycle).toBeUndefined();
      expect(t.allowedNodeTypes).toBeUndefined();
      expect(t.description).toMatch(/decision records/i);
    }
  });

  it("allows only decision-record support node types", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const allowlist = template(handle).policies.find(
        (p) => p.predicate?.kind === "requires_node_type",
      )?.predicate;
      expect(allowlist?.kind).toBe("requires_node_type");
      if (allowlist?.kind !== "requires_node_type") return;
      expect([...allowlist.node_types].sort()).toEqual(DECISION_RECORD_NODE_TYPES);
      for (const excluded of ["action", "log", "state", "idea"]) {
        expect(allowlist.node_types).not.toContain(excluded as never);
      }
      expect(allowlist.node_types).not.toContain("guidance_policy" as never);
      expect(allowlist.node_types).not.toContain("node_authoring_policy" as never);
    }
  });

  it("describes only decision-record nodes, not Doco policy metadata", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const policy = template(handle).policies.find(
        (p) => p.predicate?.kind === "requires_node_type",
      )?.policy;
      expect(policy).toMatch(/Only Intent, Decision, Eval, Reference, Rule, and Principal/i);
      expect(policy).not.toMatch(/guidance_policy|node_authoring_policy|policy records/i);
    }
  });

  it("requires proposed and active Decisions to declare the common decision-record spine", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const required = template(handle).policies.find(
        (p) =>
          p.predicate?.kind === "requires_field" &&
          p.predicate.when_node_type?.includes("decision"),
      );
      expect(required?.predicate?.kind).toBe("requires_field");
      if (required?.predicate?.kind !== "requires_field") return;
      expect(required.predicate.fields).toEqual(["question", "chosen", "alternatives"]);
      // The spine fires the moment a record is *proposed* (queued) and keeps
      // firing once *accepted* (active); a `drafting` sketch is exempt.
      expect(required.fires_when_node_lifecycle).toEqual(["queued", "active"]);
    }
  });

  it("warns on duplicate proposed-or-active questions instead of blocking successor records", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const uniqueQuestion = template(handle).policies.find(
        (p) => p.predicate?.kind === "unique_field",
      );
      expect(uniqueQuestion?.on_violation).toBe("warn");
      expect(uniqueQuestion?.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      expect(uniqueQuestion?.predicate?.kind).toBe("unique_field");
      if (uniqueQuestion?.predicate?.kind !== "unique_field") return;
      expect(uniqueQuestion.predicate.field).toBe("question");
      expect(uniqueQuestion.predicate.case_fold).toBe(true);
      expect(uniqueQuestion.predicate.when_node_type).toEqual(["decision"]);
    }
  });

  it("gates membership and quality judgments at the proposed and active stages", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const probabilistic = template(handle).policies.filter(
        (p) =>
          p.predicate?.kind === "probabilistic" && p.predicate.when_node_type?.includes("decision"),
      );
      // Both the domain-membership judge and the quality judge are gated:
      // a `drafting` sketch is never LLM-judged, but a proposed (queued) or
      // accepted (active) record is.
      expect(probabilistic.length).toBe(2);
      for (const p of probabilistic) {
        expect(p.on_violation).toBe("warn");
        expect(p.fires_when_node_lifecycle).toEqual(["queued", "active"]);
      }
    }
  });

  it("keeps the node-type allowlist a structural invariant that fires at every stage", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const allowlist = template(handle).policies.find(
        (p) => p.predicate?.kind === "requires_node_type",
      );
      // The membership allowlist describes what may exist in the Doco at all,
      // so unlike the completeness/quality gates it carries no lifecycle
      // filter — it fires on drafts and retirements alike.
      expect(allowlist?.fires_when_node_lifecycle).toBeUndefined();
    }
  });

  it("teaches the draft → propose → accept → supersede lifecycle as the decision's status", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const guidance = template(handle)
        .policies.filter((p) => !p.predicate)
        .map((p) => p.policy)
        .join("\n");
      const lifecycle = template(handle)
        .policies.filter((p) => !p.predicate)
        .map((p) => p.policy)
        .find((s) => /Lifecycle is the decision's status/i.test(s));
      expect(lifecycle).toBeDefined();
      expect(lifecycle).toMatch(/drafting/);
      expect(lifecycle).toMatch(/queued/);
      expect(lifecycle).toMatch(/\bactive\b/);
      expect(lifecycle).toMatch(/retired/);
      expect(lifecycle).toMatch(/propose/i);
      expect(lifecycle).toMatch(/accept|in force/i);
      // The append-only guidance now anchors immutability to *acceptance*,
      // leaving drafts and proposals freely revisable.
      expect(guidance).toMatch(/append-only once accepted/i);
    }
  });

  it("ships a shared append-only and evidence-linking policy spine", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const guidance = template(handle)
        .policies.filter((p) => !p.predicate)
        .map((p) => p.policy)
        .join("\n");
      expect(guidance).toMatch(/append-only/i);
      expect(guidance).toMatch(/retiring or superseding/i);
      expect(guidance).toMatch(/Use References/i);
      expect(guidance).toMatch(/Rules/i);
      expect(guidance).toMatch(/Evals/i);
      expect(guidance).toMatch(/Intents/i);
    }
  });

  it("routes off-domain decisions to the sibling decision template that should own them", () => {
    // Every membership judge should not just reject a misfiled decision — it
    // should tell the author where it belongs. Each spec's FAIL clause names at
    // least two of the other three decision-record templates.
    const siblings: Record<(typeof DECISION_RECORD_HANDLES)[number], string[]> = {
      "architectural-decisions": ["product-decisions", "design-decisions", "data-decisions"],
      "product-decisions": ["architectural-decisions", "design-decisions", "data-decisions"],
      "design-decisions": ["architectural-decisions", "product-decisions", "data-decisions"],
      "data-decisions": ["architectural-decisions", "product-decisions", "design-decisions"],
    };
    for (const handle of DECISION_RECORD_HANDLES) {
      const membership = template(handle).policies.find(
        (p) =>
          p.predicate?.kind === "probabilistic" && p.predicate.when_node_type?.includes("decision"),
      );
      const spec = membership?.predicate?.kind === "probabilistic" ? membership.predicate.spec : "";
      const named = siblings[handle].filter((s) => spec.includes(s));
      expect(named.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps domain membership judgment focused on Decisions", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const membership = template(handle).policies.find(
        (p) =>
          p.predicate?.kind === "probabilistic" && p.predicate.when_node_type?.includes("decision"),
      );
      expect(membership?.predicate?.kind).toBe("probabilistic");
      if (membership?.predicate?.kind !== "probabilistic") return;
      expect(membership.predicate.when_node_type).toEqual(["decision"]);
      const spec = membership?.predicate?.kind === "probabilistic" ? membership.predicate.spec : "";
      expect(spec).toMatch(/References/i);
      expect(spec).toMatch(/Evals/i);
      expect(spec).not.toMatch(/Intents for|Rules for|Principal nodes/i);
    }
  });

  it("documents support nodes and optional Principal nodes with shared guidance", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const guidance = template(handle)
        .policies.filter((p) => !p.predicate)
        .map((p) => p.policy)
        .join("\n");
      expect(guidance).toMatch(/Support nodes are allowed when they clearly support a Decision/i);
      expect(guidance).toMatch(/Principal nodes are optional/i);
      expect(guidance).toMatch(/name accountability in prose/i);
    }
  });

  it("uses the common quality-spec spine for every domain checklist", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const quality = template(handle).policies.find(
        (p) =>
          p.predicate?.kind === "probabilistic" &&
          p.predicate.when_node_type?.includes("decision") &&
          /active .* Decision/i.test(p.policy),
      );
      const spec = quality?.predicate?.kind === "probabilistic" ? quality.predicate.spec : "";
      expect(spec).toContain(
        "Check the Decision's `decision`, `question`, `chosen`, and `alternatives`.",
      );
      expect(spec).toContain("PASS when the record includes:");
      expect(spec).toContain("FAIL with missing aspects when");
    }
  });

  it("describes accountable decision roles with first-class attribution edges", () => {
    const guidance = template("architectural-decisions")
      .policies.filter((p) => !p.predicate)
      .map((p) => p.policy)
      .join("\n");
    expect(guidance).toMatch(/`attributed_to` edge/i);
    expect(guidance).toMatch(/role `decided_by`/i);
    expect(guidance).not.toMatch(/in `decided_by`/i);
  });

  it("specializes quality gates by decision domain", () => {
    const expectations: Record<(typeof DECISION_RECORD_HANDLES)[number], RegExp[]> = {
      "architectural-decisions": [/ADR/i, /quality attributes/i, /migration/i, /rollback/i],
      "product-decisions": [/user\/customer problem/i, /OKR/i, /success\/failure metric/i],
      "design-decisions": [/user journey/i, /accessibility/i, /Figma/i, /validation/i],
      "data-decisions": [/source of truth/i, /privacy/i, /retention/i, /lineage/i],
    };

    for (const handle of DECISION_RECORD_HANDLES) {
      const haystack = template(handle)
        .policies.flatMap((p) => [
          p.policy,
          p.predicate?.kind === "probabilistic" ? p.predicate.spec : "",
        ])
        .join("\n");
      for (const expected of expectations[handle]) {
        expect(haystack).toMatch(expected);
      }
    }
  });
});
