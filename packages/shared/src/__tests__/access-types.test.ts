import { describe, expect, it } from "vitest";
import { NEURON_TYPES } from "../branded.js";
import {
  canWriteAnything,
  canWriteType,
  isWritableType,
  normalizeWriteTypes,
  SYNAPSE_TYPES,
  WRITABLE_TYPES,
  WRITE_ALL,
} from "../access-types.js";

describe("access-types", () => {
  it("WRITABLE_TYPES is the union of neuron and synapse types, no dupes", () => {
    expect(WRITABLE_TYPES).toEqual([...NEURON_TYPES, ...SYNAPSE_TYPES]);
    expect(new Set(WRITABLE_TYPES).size).toBe(WRITABLE_TYPES.length);
  });

  it("isWritableType recognizes known types and rejects the wildcard + junk", () => {
    expect(isWritableType("decision")).toBe(true);
    expect(isWritableType("sequence_flow")).toBe(true);
    expect(isWritableType(WRITE_ALL)).toBe(false);
    expect(isWritableType("nonsense")).toBe(false);
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
      expect(canWriteType("owner", null, "sequence_flow")).toBe(true);
    });
    it("reader with no grant writes nothing", () => {
      expect(canWriteType("reader", [], "decision")).toBe(false);
      expect(canWriteType("reader", null, "decision")).toBe(false);
    });
    it("wildcard grant writes every type (legacy writer)", () => {
      expect(canWriteType("writer", [WRITE_ALL], "decision")).toBe(true);
      expect(canWriteType("reader", [WRITE_ALL], "has_stakeholder")).toBe(true);
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
