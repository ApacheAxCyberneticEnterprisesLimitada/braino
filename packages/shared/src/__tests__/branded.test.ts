import { describe, expect, it } from "vitest";
import {
  isEntityId,
  isEntityIdOf,
  isEntityType,
  isUlid,
  makeEntityId,
  parseEntityId,
} from "../branded.js";
import type { Ulid } from "../branded.js";

describe("isUlid", () => {
  it("accepts a valid 26-char Crockford string", () => {
    expect(isUlid("01KR441EA0ZDMF0N5DY38GSVS3")).toBe(true);
  });

  it("rejects too-short strings", () => {
    expect(isUlid("01KR441EA0")).toBe(false);
  });

  it("rejects forbidden characters (I, L, O, U)", () => {
    expect(isUlid("01KR441EA0ZDMF0N5DY38GSVI3")).toBe(false);
    expect(isUlid("01KR441EA0ZDMF0N5DY38GSVL3")).toBe(false);
    expect(isUlid("01KR441EA0ZDMF0N5DY38GSVO3")).toBe(false);
    expect(isUlid("01KR441EA0ZDMF0N5DY38GSVU3")).toBe(false);
  });

  it("rejects lowercase", () => {
    expect(isUlid("01kr441ea0zdmf0n5dy38gsvs3")).toBe(false);
  });
});

describe("isEntityId", () => {
  it("accepts well-formed prefixed IDs", () => {
    expect(isEntityId("decision_01KR441EAMKYKCEBSEYHGJ8M3Z")).toBe(true);
    expect(isEntityId("intent_01KR441EA92V53H22ZN087YMRM")).toBe(true);
    expect(isEntityId("doco_01KR441EA0ZDMF0N5DY38GSVS3")).toBe(true);
  });

  it("rejects unknown prefixes", () => {
    expect(isEntityId("widget_01KR441EAMKYKCEBSEYHGJ8M3Z")).toBe(false);
  });

  it("rejects missing underscore separator", () => {
    expect(isEntityId("decision01KR441EAMKYKCEBSEYHGJ8M3Z")).toBe(false);
  });

  it("rejects malformed ULID portion", () => {
    expect(isEntityId("decision_short")).toBe(false);
  });
});

describe("isEntityIdOf", () => {
  it("narrows to the requested node type", () => {
    expect(isEntityIdOf("rule_01KR441EAF7M5QPF65BXGD1ET1", "rule")).toBe(true);
    expect(isEntityIdOf("rule_01KR441EAF7M5QPF65BXGD1ET1", "intent")).toBe(false);
  });
});

describe("isEntityType", () => {
  it("accepts every known kind", () => {
    for (const t of [
      "doco",
      "principal",
      "organization",
      "intent",
      "idea",
      "rule",
      "guidance_primitive",
      "neuron_authoring_primitive",
      "decision",
      "action",
      "eval",
      "reference",
    ]) {
      expect(isEntityType(t)).toBe(true);
    }
  });

  it("rejects unknown kinds", () => {
    expect(isEntityType("widget")).toBe(false);
    expect(isEntityType("tag")).toBe(false);
    expect(isEntityType("scope")).toBe(false);
  });
});

describe("parseEntityId", () => {
  it("returns the type + ulid pair", () => {
    const parsed = parseEntityId("decision_01KR441EAMKYKCEBSEYHGJ8M3Z");
    expect(parsed).toEqual({ type: "decision", ulid: "01KR441EAMKYKCEBSEYHGJ8M3Z" });
  });

  it("returns null for malformed input", () => {
    expect(parseEntityId("widget_01KR441EAMKYKCEBSEYHGJ8M3Z")).toBeNull();
    expect(parseEntityId("")).toBeNull();
  });
});

describe("makeEntityId", () => {
  it("composes type and ulid into a branded id", () => {
    const id = makeEntityId("decision", "01KR441EAMKYKCEBSEYHGJ8M3Z" as Ulid);
    expect(id).toBe("decision_01KR441EAMKYKCEBSEYHGJ8M3Z");
    expect(isEntityIdOf(id, "decision")).toBe(true);
  });
});
