import { describe, expect, it } from "vitest";
import { loader as authorizationServer } from "./oauth-metadata-authorization-server";
import { loader as protectedResource } from "./oauth-metadata-protected-resource.mcp";

describe("instance-local MCP OAuth metadata", () => {
  it("publishes DCR, PKCE, issuer identification, and only the local MCP resource", async () => {
    const request = new Request("https://knowledge.example/.well-known/oauth-authorization-server");
    const authorization = await authorizationServer({ request });
    expect(await authorization.json()).toMatchObject({
      issuer: "https://knowledge.example",
      authorization_endpoint: "https://knowledge.example/oauth/authorize",
      token_endpoint: "https://knowledge.example/oauth/token",
      registration_endpoint: "https://knowledge.example/oauth/register",
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["braino:mcp"],
    });

    const resource = await protectedResource({
      request: new Request("https://knowledge.example/.well-known/oauth-protected-resource/mcp"),
    });
    expect(await resource.json()).toEqual({
      resource: "https://knowledge.example/mcp",
      authorization_servers: ["https://knowledge.example"],
      scopes_supported: ["braino:mcp"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://knowledge.example/mcp-tokens",
    });
  });
});
