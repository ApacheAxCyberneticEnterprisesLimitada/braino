import { describe, expect, it } from "vitest";
import { mcpResource, protectedResourceMetadataUrl, publicOrigin } from "./public-origin.server";

describe("instance-local public origin", () => {
  it("keeps every OAuth and MCP URL on the configured self-hosted instance", () => {
    const request = new Request("http://app:3000/admin");
    const env = { DOCO_PUBLIC_HOST: "https://knowledge.example/" };

    expect(publicOrigin(request, env)).toBe("https://knowledge.example");
    expect(mcpResource(request, env)).toBe("https://knowledge.example/mcp");
    expect(protectedResourceMetadataUrl(request, env)).toBe(
      "https://knowledge.example/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("falls back to the request origin for local development", () => {
    const request = new Request("http://localhost:5173/admin");
    expect(publicOrigin(request, {})).toBe("http://localhost:5173");
  });
});
