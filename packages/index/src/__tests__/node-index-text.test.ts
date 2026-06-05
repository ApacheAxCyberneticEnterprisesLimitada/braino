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

function le(typeNamedValue: string | null, data: Record<string, unknown> = {}): LoadedEntity {
  return {
    entity: data as unknown as LoadedEntity["entity"],
    filePath: "<test>",
    parsed: { data, body: "", format: "postgres", typeNamedValue },
  } as LoadedEntity;
}

describe("nodeIndexText", () => {
  it("uses the node's prose, trimmed, when present", () => {
    expect(nodeIndexText(le("  Real prose here  ", { locator: "https://x/1" }))).toBe(
      "Real prose here",
    );
  });

  it("falls back to title + locator when the prose is empty", () => {
    expect(
      nodeIndexText(le("", { title: "Draft PR title", locator: "https://github.com/o/r/pull/9" })),
    ).toBe("Draft PR title — https://github.com/o/r/pull/9");
  });

  it("falls back to the locator alone when that is all the node carries", () => {
    expect(
      nodeIndexText(le(null, { ref_type: "url", locator: "https://github.com/o/r/pull/9" })),
    ).toBe("https://github.com/o/r/pull/9");
  });

  it("de-duplicates identical fallback fields", () => {
    expect(nodeIndexText(le("   ", { title: "same", citation: "same" }))).toBe("same");
  });

  it("returns an empty string when there is genuinely nothing to index", () => {
    expect(nodeIndexText(le("   ", { ref_type: "url", outcome: "succeeded" }))).toBe("");
  });

  // Title/body split recall-identity: a PR reference now stores the title in
  // prose and the body in attributes.body_md (surfaced as a flat `body_md` key
  // on `data`). The indexed text must stay BYTE-IDENTICAL to the old merged
  // prose ("title\n\nbody") so the FTS body and embedding text — and thus search
  // recall — are unchanged by the split.
  it("appends body_md to the prose, reproducing the pre-split merged text", () => {
    expect(nodeIndexText(le("Fix X", { body_md: "### Problem\n…" }))).toBe(
      "Fix X\n\n### Problem\n…",
    );
  });

  it("uses prose alone when there is no body_md", () => {
    expect(nodeIndexText(le("Fix X", { ref_type: "url" }))).toBe("Fix X");
  });

  it("ignores a blank body_md (no trailing separator)", () => {
    expect(nodeIndexText(le("Fix X", { body_md: "   " }))).toBe("Fix X");
  });
});
