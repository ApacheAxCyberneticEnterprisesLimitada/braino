import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COLLECTION_TEMPLATES } from "@doco/host";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Braino's public identity", () => {
  it("presents Braino on every human-facing open-source surface", () => {
    for (const path of [
      "README.md",
      "docs/operations.md",
      "docs/v0.1-conformance.md",
      "scripts/conformance.sh",
      "packages/db/package.json",
      "packages/connector-plugins/package.json",
      "packages/web/package.json",
      "packages/web/app/root.tsx",
      "packages/web/app/routes/_index.tsx",
      "packages/web/app/routes/search.tsx",
      "packages/web/app/routes/integrations.tsx",
      "packages/web/app/routes/collaborators.tsx",
      "packages/web/app/routes/$collectionHandle.tsx",
      "packages/web/app/routes/$collectionHandle.$nodeId.tsx",
      "packages/web/app/routes/mcp-tokens.tsx",
      "packages/web/app/routes/mcp.ts",
      "packages/web/app/lib/mcp-server.ts",
      "packages/host/src/single-workspace.ts",
      "packages/host/src/mcp-core.ts",
      "packages/db/src/client.ts",
    ]) {
      expect(read(path), path).not.toMatch(/\bDoco\b|Señor Doco/);
    }
    expect(
      DEFAULT_COLLECTION_TEMPLATES.map((template) => template.description).join("\n"),
    ).not.toMatch(/\bDoco\b/);
  });

  it("uses the established Braino mark and release image", () => {
    expect(read("packages/web/app/components/braino-mark.tsx")).toContain('ariaLabel = "Braino"');
    expect(read("packages/web/app/root.tsx")).toContain("<BrainoMark height={28}");
    expect(read("packages/web/public/favicon.svg")).toContain('aria-label="Braino"');
    expect(read("packages/web/public/logotype.svg")).toContain('aria-label="Braino"');
    expect(read(".github/workflows/release.yml")).toContain(
      'IMAGE="ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/braino"',
    );
    expect(read(".env.example")).toContain("ghcr.io/brainoinc/braino:latest");
    expect(read("docs/operations.md")).toContain("ghcr.io/brainoinc/braino");
  });

  it("moves existing display data forward without renaming machine contracts", () => {
    const schema = read("packages/db/src/schema.sql");
    const migration = read("packages/db/migrations/002_braino_product_identity.sql");

    expect(schema).toContain("VALUES ('host', 'Braino', 'public')");
    expect(migration).toContain("name = 'Braino'");
    expect(read("packages/host/src/mcp-core.ts")).toContain('const MCP_CLIENT_ID = "doco_');
    expect(read("compose.yml")).toContain("doco-postgres:");
    expect(read(".env.example")).toContain("DOCO_IMAGE=");
  });
});
