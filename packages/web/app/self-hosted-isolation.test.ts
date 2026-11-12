import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname);

function read(path: string): string {
  return readFileSync(resolve(app, path), "utf8");
}

describe("self-hosted instance isolation", () => {
  it("derives OAuth and MCP endpoints from the instance without a Braino relay", () => {
    const surface = [
      read("lib/public-origin.server.ts"),
      read("routes/oauth-metadata-authorization-server.ts"),
      read("routes/oauth-metadata-protected-resource.mcp.ts"),
      read("routes/oauth.authorize.tsx"),
      read("routes/oauth.token.ts"),
      read("routes/mcp.ts"),
    ].join("\n");

    expect(surface).toContain("DOCO_PUBLIC_HOST");
    expect(surface).not.toMatch(/connect\.braino\.dev|https:\/\/braino\.dev/);
    expect(surface).not.toContain("fetch(");
  });
});
