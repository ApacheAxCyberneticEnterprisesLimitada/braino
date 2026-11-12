import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  exchange: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => {
  class McpOauthError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    McpOauthError,
    registerMcpOauthClient: mocks.register,
    exchangeMcpOauthAuthorizationCode: mocks.exchange,
    refreshMcpOauthTokens: mocks.refresh,
  };
});

import { action as register } from "./oauth.register";
import { action as token } from "./oauth.token";

describe("instance-local OAuth HTTP endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockResolvedValue({
      clientId: "doco_client_chatgpt",
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      registeredAt: "2026-11-12T00:00:00.000Z",
    });
    mocks.exchange.mockResolvedValue({
      access_token: "doco_at_one",
      refresh_token: "doco_rt_one",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "braino:mcp",
    });
  });

  it("registers a public DCR client without issuing a client secret", async () => {
    const response = await register({
      request: new Request("https://knowledge.example/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "ChatGPT",
          redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
          token_endpoint_auth_method: "none",
        }),
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body.client_id).toBe("doco_client_chatgpt");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body).not.toHaveProperty("client_secret");
  });

  it("rejects a token exchange addressed to another Braino instance", async () => {
    const response = await token({
      request: new Request("https://knowledge.example/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "doco_client_chatgpt",
          code: "doco_code_one",
          redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
          code_verifier: "x".repeat(43),
          resource: "https://another-instance.example/mcp",
        }),
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_target" });
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
});
