import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_CHECKS,
  DETERMINISTIC_SUB_KINDS,
  checkFields,
  checkFieldsValidationErrors,
  checkLabel,
} from "../deterministic-checks.js";
import type { DeterministicPredicate, DeterministicSubKind } from "../entities.js";

describe("deterministic-checks registry — single source of truth", () => {
  it("derives the sub-kind list from the registry keys (no hand-kept copy)", () => {
    expect(new Set(DETERMINISTIC_SUB_KINDS)).toEqual(new Set(Object.keys(DETERMINISTIC_CHECKS)));
  });

  it("gives every check a human label and a field schema", () => {
    for (const sub_kind of DETERMINISTIC_SUB_KINDS) {
      const spec = DETERMINISTIC_CHECKS[sub_kind];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(Array.isArray(spec.fields)).toBe(true);
      expect(typeof spec.evaluate).toBe("function");
    }
  });

  it("keeps the once-drifted edge-policy sub-kinds in the set", () => {
    for (const sk of [
      "limits_edge",
      "requires_edge_type",
      "forbids_field_pattern",
      "flow-wiring",
    ]) {
      expect(DETERMINISTIC_SUB_KINDS).toContain(sk);
    }
  });
});

describe("unknown sub_kind — total, never-throwing lookups", () => {
  // Stored policy `data` is jsonb that predates the current registry, was
  // imported (e.g. a BPMN Doco), or was hand-edited — so a policy's
  // `sub_kind` can be a value the registry no longer knows. The lookups must
  // be total: indexing `DETERMINISTIC_CHECKS[unknown]` blindly threw
  // `undefined is not an object (evaluating 'w[e].fields')`, which crashed the
  // whole policies page and left no way to even retire the offending policy.
  const unknown = "obsolete_check" as DeterministicSubKind;

  it("returns no fields for an unknown sub_kind instead of throwing", () => {
    expect(() => checkFields(unknown)).not.toThrow();
    expect(checkFields(unknown)).toEqual([]);
  });

  it("falls back to the raw sub_kind as the label so the policy stays identifiable", () => {
    expect(() => checkLabel(unknown)).not.toThrow();
    expect(checkLabel(unknown)).toBe("obsolete_check");
  });
});

describe("registry-driven edge-type validation — closes the flow-wiring drift", () => {
  it("rejects a flow-wiring predicate whose edge_type is not a first-class edge type", () => {
    const predicate = {
      sub_kind: "flow-wiring",
      edge_type: "not_a_real_edge_type",
    } as DeterministicPredicate;
    const errors = checkFieldsValidationErrors(predicate);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/edge_type/);
  });

  it("accepts a flow-wiring predicate with a real edge_type", () => {
    const predicate = {
      sub_kind: "flow-wiring",
      edge_type: "flows_to",
    } as DeterministicPredicate;
    expect(checkFieldsValidationErrors(predicate)).toEqual([]);
  });
});
