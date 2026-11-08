import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(resolve(import.meta.dirname, "$collectionHandle.tsx"), "utf8");

describe("collection reader query", () => {
  it("reads record titles from the canonical nodes.extra projection", () => {
    expect(route).toContain("extra->>'title'");
    expect(route).toContain("extra->>'name'");
    expect(route).toContain("split_part(prose, E'\\n', 1)");
    expect(route).not.toContain("data->>'title'");
    expect(route).not.toContain("data->>'name'");
  });
});
