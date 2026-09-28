import { describe, expect, it } from "vitest";
import { CHUNK_CHARS, chunkText, nodeIndexText } from "../chunks.js";

describe("chunkText", () => {
  it("returns nothing for blank text and one chunk for short text", () => {
    expect(chunkText("  \n ")).toEqual([]);
    expect(chunkText("A short note.\r\nSecond line.  ")).toEqual(["A short note.\nSecond line."]);
  });

  it("cuts long text on a paragraph break in the second half of a window, overlapping", () => {
    const paragraph = (n: number) => `Paragraph ${n}. ${"word ".repeat(60).trim()}.`;
    const paragraphs = [1, 2, 3, 4, 5, 6].map(paragraph);
    const chunks = chunkText(paragraphs.join("\n\n"));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(paragraphs.slice(0, 5).join("\n\n"));
    expect(chunks[0].length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(chunks[1]).toContain("Paragraph 6.");
    // The second chunk opens with the tail of the first, on a word boundary.
    expect(chunks[0]).toContain(chunks[1].slice(0, 150));
    expect(chunks[1].startsWith("word")).toBe(true);
  });

  it("hard-splits a run with no boundaries, honoring a custom size", () => {
    const chunks = chunkText("x".repeat(4000), { maxChars: 1000, overlapChars: 100 });
    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks[1]).toBe("x".repeat(1000));
  });
});

describe("nodeIndexText", () => {
  it("is the prose when there is any", () => {
    expect(nodeIndexText("  Real prose here  ", { locator: "https://x/1" })).toBe(
      "Real prose here",
    );
  });

  it("falls back to the identifying fields, deduped, when the prose is empty", () => {
    expect(
      nodeIndexText("", { name: "Draft seat", locator: "https://github.com/o/r/pull/9" }),
    ).toBe("https://github.com/o/r/pull/9 — Draft seat");
    expect(nodeIndexText("   ", { name: "same", verb: "same" })).toBe("same");
    expect(nodeIndexText(null, { ref_type: "url", outcome: "succeeded" })).toBe("");
    expect(nodeIndexText(undefined, null)).toBe("");
  });
});
