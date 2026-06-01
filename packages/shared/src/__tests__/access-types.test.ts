import { describe, expect, it } from "vitest";
import {
  EDGE_ENDPOINT_TYPES,
  EDGE_TYPES,
  WRITABLE_TYPES,
  WRITE_ALL,
  canWriteAnything,
  canWriteType,
  isWritableType,
  normalizeWriteTypes,
} from "../access-types.js";
import { NODE_TYPES } from "../branded.js";

const CANONICAL_EDGE_TYPES = [
  "flows_to",
  "supports",
  "constrained_by",
  "attributed_to",
  "has_parent",
  "derived_from",
  "replaces",
  "relates_to",
] as const;

describe("access-types", () => {
  it("WRITABLE_TYPES is the union of node and edge types, no dupes", () => {
    expect(WRITABLE_TYPES).toEqual([...NODE_TYPES, ...EDGE_TYPES]);
    expect(new Set(WRITABLE_TYPES).size).toBe(WRITABLE_TYPES.length);
  });

  it("keeps the relation vocabulary to the canonical edge families", () => {
    expect(EDGE_TYPES).toEqual(CANONICAL_EDGE_TYPES);
  });

  describe("EDGE_ENDPOINT_TYPES", () => {
    const nodeSet = new Set<string>(NODE_TYPES);
    const edgeSet = new Set<string>(EDGE_TYPES);

    it("only constrains real edge types with real node types", () => {
      for (const [edgeType, ends] of Object.entries(EDGE_ENDPOINT_TYPES)) {
        expect(edgeSet.has(edgeType)).toBe(true);
        for (const t of [...(ends.from ?? []), ...(ends.to ?? [])]) {
          expect(nodeSet.has(t)).toBe(true);
        }
      }
    });

    it("pins only the canonical endpoint shapes that remain unambiguous", () => {
      expect(EDGE_ENDPOINT_TYPES.constrained_by?.to).toEqual(["rule"]);
      expect(EDGE_ENDPOINT_TYPES.attributed_to?.to).toEqual(["principal"]);
    });

    it("leaves broad edge families unconstrained", () => {
      for (const generic of [
        "flows_to",
        "supports",
        "has_parent",
        "derived_from",
        "replaces",
        "relates_to",
      ]) {
        expect(EDGE_ENDPOINT_TYPES[generic]).toBeUndefined();
      }
    });
  });

  it("isWritableType recognizes known types and rejects the wildcard + junk", () => {
    expect(isWritableType("decision")).toBe(true);
    expect(isWritableType("flows_to")).toBe(true);
    expect(isWritableType(WRITE_ALL)).toBe(false);
    expect(isWritableType("nonsense")).toBe(false);
  });

  it("does not grant writes to legacy relation aliases as edge types", () => {
    for (const legacy of [
      "sequence_flow",
      "performed_by",
      "reports_to",
      "superseded_by",
      "templated_by",
      "decided_by",
    ]) {
      expect(isWritableType(legacy)).toBe(false);
    }
  });

  describe("normalizeWriteTypes", () => {
    it("drops unknown tokens and de-duplicates", () => {
      expect(normalizeWriteTypes(["decision", "decision", "junk"])).toEqual(["decision"]);
    });
    it("collapses a set containing the wildcard to just the wildcard", () => {
      expect(normalizeWriteTypes(["decision", WRITE_ALL, "intent"])).toEqual([WRITE_ALL]);
    });
    it("returns [] for non-arrays", () => {
      expect(normalizeWriteTypes(null)).toEqual([]);
      expect(normalizeWriteTypes("decision")).toEqual([]);
    });
  });

  describe("canWriteType", () => {
    it("owner writes everything regardless of write-type set", () => {
      expect(canWriteType("owner", [], "decision")).toBe(true);
      expect(canWriteType("owner", null, "flows_to")).toBe(true);
    });
    it("reader with no grant writes nothing", () => {
      expect(canWriteType("reader", [], "decision")).toBe(false);
      expect(canWriteType("reader", null, "decision")).toBe(false);
    });
    it("wildcard grant writes every type (legacy writer)", () => {
      expect(canWriteType("writer", [WRITE_ALL], "decision")).toBe(true);
      expect(canWriteType("reader", [WRITE_ALL], "attributed_to")).toBe(true);
    });
    it("named grant writes only the named types", () => {
      expect(canWriteType("reader", ["decision", "intent"], "decision")).toBe(true);
      expect(canWriteType("reader", ["decision", "intent"], "action")).toBe(false);
    });
  });

  describe("canWriteAnything", () => {
    it("owner always can; reader-with-grant can; reader-without can't", () => {
      expect(canWriteAnything("owner", [])).toBe(true);
      expect(canWriteAnything("reader", ["decision"])).toBe(true);
      expect(canWriteAnything("reader", [])).toBe(false);
      expect(canWriteAnything("reader", null)).toBe(false);
    });
  });
});
