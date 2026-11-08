import { describe, expect, it } from "vitest";
import { MCP_TOOL_NAMES, handleMcpMessage } from "./mcp-server";

const principal = {
  userId: "user_01J00000000000000000000000",
  workspaceId: "workspace_01J0000000000000000000",
  role: "owner" as const,
  label: "test",
};

describe("stateless MCP protocol", () => {
  it("negotiates initialization and advertises the core tools", async () => {
    await expect(
      handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
        principal,
      ),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "Doco", version: expect.any(String) },
        capabilities: { tools: {} },
      },
    });

    const listed = await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      principal,
    );
    const tools = (listed as unknown as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
  });

  it("acknowledges notifications and rejects unknown methods as JSON-RPC", async () => {
    await expect(
      handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, principal),
    ).resolves.toBeNull();
    await expect(
      handleMcpMessage({ jsonrpc: "2.0", id: "x", method: "not-real" }, principal),
    ).resolves.toMatchObject({ error: { code: -32601 }, id: "x" });
  });
});
