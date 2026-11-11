import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const route = readFileSync(resolve(import.meta.dirname, "$collectionHandle.tsx"), "utf8");
const routes = readFileSync(resolve(import.meta.dirname, "../routes.ts"), "utf8");
const codeRoute = readFileSync(
  resolve(import.meta.dirname, "$collectionHandle.code.$.tsx"),
  "utf8",
);

describe("collection reader query", () => {
  it("reads record titles from the canonical nodes.extra projection", () => {
    expect(route).toContain("extra->>'title'");
    expect(route).toContain("extra->>'name'");
    expect(route).toContain("split_part(prose, E'\\n', 1)");
    expect(route).not.toContain("data->>'title'");
    expect(route).not.toContain("data->>'name'");
  });

  it("routes codebase collections to a local file and relationship reader", () => {
    expect(route).toContain('collection.template_handle === "codebase"');
    expect(routes).toContain('route(":collectionHandle/code/*"');
    expect(codeRoute).toContain("FROM code_files");
    expect(codeRoute).toContain("CASE WHEN $2::text IS NULL THEN '' ELSE content END AS content");
    expect(codeRoute).toContain("FROM retrieval_relations");
    expect(codeRoute).toContain("Code relationships");
  });
});
