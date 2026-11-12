import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getMcpOauthClient: vi.fn(),
  issueMcpOauthAuthorizationCode: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  MCP_OAUTH_SCOPE: "braino:mcp",
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getMcpOauthClient: mocks.getMcpOauthClient,
  issueMcpOauthAuthorizationCode: mocks.issueMcpOauthAuthorizationCode,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { action, loader } from "./oauth.authorize";

const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const authorize = new URL("https://knowledge.example/oauth/authorize");
authorize.search = new URLSearchParams({
  response_type: "code",
  client_id: "doco_client_chatgpt",
  redirect_uri: callback,
  code_challenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
  code_challenge_method: "S256",
  scope: "braino:mcp",
  resource: "https://knowledge.example/mcp",
  state: "opaque-state",
}).toString();
const authorizeUrl = authorize.toString();

describe("instance-local OAuth authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSingleWorkspaceState.mockResolvedValue({
      initialized: true,
      workspace: { id: "workspace_acme", handle: "acme", name: "Acme" },
    });
    mocks.getMcpOauthClient.mockResolvedValue({
      clientId: "doco_client_chatgpt",
      clientName: "ChatGPT",
      redirectUris: [callback],
    });
    mocks.issueMcpOauthAuthorizationCode.mockResolvedValue({ code: "doco_code_one" });
  });

  it("returns an unsigned user to the exact local authorization request after sign-in", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    try {
      await loader({ request: new Request(authorizeUrl) });
      throw new Error("Expected the loader to redirect to sign-in.");
    } catch (error) {
      expect((error as Response).status).toBe(302);
      expect((error as Response).headers.get("location")).toBe(
        `/?next=${encodeURIComponent(new URL(authorizeUrl).pathname + new URL(authorizeUrl).search)}`,
      );
    }
  });

  it("issues a workspace-only code and returns issuer identification to the client", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "user_owner", name: "Owner" });
    const request = new Request(authorizeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "decision=allow",
    });

    const response = await action({ request });

    expect(mocks.issueMcpOauthAuthorizationCode).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: "user_owner",
        workspaceId: "workspace_acme",
        scope: "braino:mcp",
        resource: "https://knowledge.example/mcp",
      }),
    );
    const location = new URL(response.headers.get("location") ?? "missing:");
    expect(location.origin + location.pathname).toBe(callback);
    expect(location.searchParams.get("code")).toBe("doco_code_one");
    expect(location.searchParams.get("state")).toBe("opaque-state");
    expect(location.searchParams.get("iss")).toBe("https://knowledge.example");
  });
});
