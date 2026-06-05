import { describe, expect, it } from "vitest";
import { buildTemplatePerspectiveSeeds } from "../host.js";

describe("buildTemplatePerspectiveSeeds", () => {
  it("defaults graph when a template does not name a default perspective", () => {
    expect(buildTemplatePerspectiveSeeds(null)).toEqual([
      { slug: "graph", perspectiveId: "perspective_graph", position: 0, isDefault: true },
      { slug: "list", perspectiveId: "perspective_list", position: 1, isDefault: false },
    ]);
  });

  it("lets templates make the built-in List perspective the default", () => {
    expect(
      buildTemplatePerspectiveSeeds({
        perspectives: [{ slug: "list", isDefault: true }],
      }),
    ).toEqual([
      { slug: "graph", perspectiveId: "perspective_graph", position: 0, isDefault: false },
      { slug: "list", perspectiveId: "perspective_list", position: 1, isDefault: true },
    ]);
  });

  it("keeps extra perspective defaults after built-ins", () => {
    expect(
      buildTemplatePerspectiveSeeds({
        perspectives: [{ slug: "sla", isDefault: true }],
      }),
    ).toEqual([
      { slug: "graph", perspectiveId: "perspective_graph", position: 0, isDefault: false },
      { slug: "list", perspectiveId: "perspective_list", position: 1, isDefault: false },
      { slug: "sla", position: 2, isDefault: true },
    ]);
  });

  it("does not duplicate built-in perspectives when they are declared by slug", () => {
    const seeds = buildTemplatePerspectiveSeeds({
      perspectives: [{ slug: "list", isDefault: true }, { slug: "graph" }, { slug: "process" }],
    });

    expect(seeds.map((s) => s.slug)).toEqual(["graph", "list", "process"]);
    expect(seeds.find((s) => s.slug === "list")?.isDefault).toBe(true);
    expect(seeds.find((s) => s.slug === "process")?.position).toBe(2);
  });
});
