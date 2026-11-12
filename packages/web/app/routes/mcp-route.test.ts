import { describe, expect, it } from "vitest";
import { action } from "./mcp";

function call(method: string, params?: unknown) {
  return action({
    request: new Request("https://knowledge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  });
}

describe("mixed-auth MCP transport", () => {
  it("lists OAuth-protected tools before sign-in", async () => {
    const response = await call("tools/list");
    const body = (await response.json()) as {
      result: { tools: Array<{ _meta: { securitySchemes: unknown[] } }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools.length).toBeGreaterThan(0);
    expect(body.result.tools.every((tool) => tool._meta.securitySchemes.length > 0)).toBe(true);
  });

  it("challenges an anonymous tool call against only this instance", async () => {
    const response = await call("tools/call", {
      name: "list_workspaces",
      arguments: {},
    });
    const body = (await response.json()) as {
      result: { isError: boolean; _meta: { "mcp/www_authenticate": string[] } };
    };

    expect(response.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result._meta["mcp/www_authenticate"][0]).toContain(
      "https://knowledge.example/.well-known/oauth-protected-resource/mcp",
    );
  });
});
