import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSingleWorkspaceState: vi.fn(),
  initializeSingleWorkspace: vi.fn(),
  hashPassword: vi.fn(),
  passwordError: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  clearPasswordSignInAttempts: vi.fn(),
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  initializeSingleWorkspace: mocks.initializeSingleWorkspace,
  reservePasswordSignInAttempt: vi.fn(),
  revokeUserSessions: vi.fn(),
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: vi.fn() }));
vi.mock("~/lib/password.server", () => ({
  hashPassword: mocks.hashPassword,
  passwordError: mocks.passwordError,
  verifyPassword: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({
  clearSessionCookie: vi.fn(),
  createSessionCookie: () => "doco_session=test; Path=/",
}));
vi.mock("~/lib/setup-token.server", () => ({ setupTokenError: () => null }));
vi.mock("~/lib/sign-in.server", () => ({ passwordAttemptBuckets: vi.fn() }));

import { action } from "./_index";

describe("first-run setup password", () => {
  it("creates the workspace from one password field", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.hashPassword.mockResolvedValue("scrypt$test");
    mocks.passwordError.mockReturnValue(null);
    mocks.initializeSingleWorkspace.mockResolvedValue({
      owner: { id: "user_owner", stamp: "stamp_owner" },
      workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    });
    const body = new URLSearchParams({
      intent: "setup",
      workspace_name: "Meta Braino",
      workspace_handle: "meta-braino",
      owner_name: "Owner",
      owner_username: "owner",
      owner_email: "owner@example.com",
      setup_token: "valid-setup-token",
      password: "generated-password-123",
    });

    const response = await action({
      request: new Request("https://meta.braino.dev/?index", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    });

    expect(mocks.hashPassword).toHaveBeenCalledWith("generated-password-123");
    expect(mocks.initializeSingleWorkspace).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ownerPasswordHash: "scrypt$test" }),
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Expected setup to redirect.");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  it("returns validation failures as inline action data", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.passwordError.mockReturnValue("Use at least 12 characters.");
    const body = new URLSearchParams({
      intent: "setup",
      setup_token: "valid-setup-token",
      password: "short",
    });

    const result = await action({
      request: new Request("https://meta.braino.dev/?index", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    });

    expect(result).toEqual({ error: "Use at least 12 characters." });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it("preserves password characters exactly", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.hashPassword.mockResolvedValue("scrypt$test");
    mocks.passwordError.mockReturnValue(null);
    mocks.initializeSingleWorkspace.mockResolvedValue({
      owner: { id: "user_owner", stamp: "stamp_owner" },
      workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    });
    const password = "  generated password 123  ";
    const body = new URLSearchParams({
      intent: "setup",
      workspace_name: "Meta Braino",
      workspace_handle: "meta-braino",
      owner_name: "Owner",
      owner_username: "owner",
      owner_email: "owner@example.com",
      setup_token: "valid-setup-token",
      password,
    });

    await action({
      request: new Request("https://meta.braino.dev/?index", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    });

    expect(mocks.passwordError).toHaveBeenCalledWith(password);
    expect(mocks.hashPassword).toHaveBeenCalledWith(password);
  });

  it("renders one password-manager-friendly setup field", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");

    expect(source).toContain('name="password"');
    expect(source).toContain('autoComplete="new-password"');
    expect(source).toContain("maxLength={200}");
    expect(source).not.toContain("password_confirmation");
    expect(source).not.toContain("Confirm password");
  });
});
