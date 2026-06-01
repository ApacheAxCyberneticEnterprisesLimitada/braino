import { describe, expect, it } from "vitest";
import { DEFAULT_DOCO_TEMPLATES, findDocoTemplateByName } from "../doco-templates.js";

const DECISION_RECORD_HANDLES = [
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "data-decisions",
] as const;

const DECISION_RECORD_ENTITY_TYPES = [
  "decision",
  "eval",
  "guidance_policy",
  "intent",
  "node_authoring_policy",
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

  it("allows only decision-record support entities and in-Doco policies", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const allowlist = template(handle).policies.find(
        (p) => p.predicate?.kind === "requires_entity_type",
      )?.predicate;
      expect(allowlist?.kind).toBe("requires_entity_type");
      if (allowlist?.kind !== "requires_entity_type") return;
      expect([...allowlist.entity_types].sort()).toEqual(DECISION_RECORD_ENTITY_TYPES);
      for (const excluded of ["action", "log", "state", "idea"]) {
        expect(allowlist.entity_types).not.toContain(excluded);
      }
    }
  });

  it("requires active Decisions to declare the common decision-record spine", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const required = template(handle).policies.find(
        (p) =>
          p.predicate?.kind === "requires_field" &&
          p.predicate.when_node_type?.includes("decision"),
      );
      expect(required?.predicate?.kind).toBe("requires_field");
      if (required?.predicate?.kind !== "requires_field") return;
      expect(required.predicate.fields).toEqual(["question", "chosen", "alternatives"]);
      expect(required.fires_when_node_lifecycle).toEqual(["asserted"]);
    }
  });

  it("warns on duplicate active questions instead of blocking successor records", () => {
    for (const handle of DECISION_RECORD_HANDLES) {
      const uniqueQuestion = template(handle).policies.find(
        (p) => p.predicate?.kind === "unique_field",
      );
      expect(uniqueQuestion?.on_violation).toBe("warn");
      expect(uniqueQuestion?.fires_when_node_lifecycle).toEqual(["asserted"]);
      expect(uniqueQuestion?.predicate?.kind).toBe("unique_field");
      if (uniqueQuestion?.predicate?.kind !== "unique_field") return;
      expect(uniqueQuestion.predicate.field).toBe("question");
      expect(uniqueQuestion.predicate.case_fold).toBe(true);
      expect(uniqueQuestion.predicate.when_node_type).toEqual(["decision"]);
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
