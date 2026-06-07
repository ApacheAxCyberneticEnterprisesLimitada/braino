// Unit coverage for the node→indexable-text derivation.
//
// The bug this guards: a node whose prose is empty (a content-thin draft —
// e.g. a freshly-created Reference whose body isn't written yet) used to be
// dropped from the index entirely (`if (!text) continue`), so it was in the
// `nodes` table — and on the page — but invisible to search. The fallback
// pulls the node's identifying fields in so it still gets indexed.

import type { LoadedEntity } from "@doco/shared";
import { describe, expect, it } from "vitest";
import { nodeIndexText } from "../build.js";

function le(prose: string | null, data: Record<string, unknown> = {}): LoadedEntity {
  return {
    entity: data as unknown as LoadedEntity["entity"],
    filePath: "<test>",
    parsed: { data, format: "postgres", prose },
  } as LoadedEntity;
}

describe("nodeIndexText", () => {
  it("uses the node's prose, trimmed, when present", () => {
    expect(nodeIndexText(le("  Real prose here  ", { locator: "https://x/1" }))).toBe(
      "Real prose here",
    );
  });

  it("falls back to locator + name (in field order) when the prose is empty", () => {
    expect(
      nodeIndexText(le("", { name: "Draft seat", locator: "https://github.com/o/r/pull/9" })),
    ).toBe("https://github.com/o/r/pull/9 — Draft seat");
  });

  it("falls back to the locator alone when that is all the node carries", () => {
    expect(
      nodeIndexText(le(null, { ref_type: "url", locator: "https://github.com/o/r/pull/9" })),
    ).toBe("https://github.com/o/r/pull/9");
  });

  it("de-duplicates identical fallback fields", () => {
    expect(nodeIndexText(le("   ", { name: "same", verb: "same" }))).toBe("same");
  });

  it("returns an empty string when there is genuinely nothing to index", () => {
    expect(nodeIndexText(le("   ", { ref_type: "url", outcome: "succeeded" }))).toBe("");
  });

  // A node's only text is its `prose` — there is no separate body to append.
  it("uses the prose alone, ignoring other per-node extra", () => {
    expect(nodeIndexText(le("Fix X", { ref_type: "url", locator: "https://x/9" }))).toBe("Fix X");
  });
});
