import { createHash } from "node:crypto";
import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { authenticateMcpToken, listMcpTokens, revokeMcpToken } from "../mcp-core.js";
import {
  MCP_OAUTH_SCOPE,
  McpOauthError,
  exchangeMcpOauthAuthorizationCode,
  issueMcpOauthAuthorizationCode,
  refreshMcpOauthTokens,
  registerMcpOauthClient,
} from "../mcp-oauth.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const resource = "https://knowledge.example/mcp";
const verifier = "braino-local-oauth-verifier-with-more-than-forty-three-characters";
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const oauthClient = await registerMcpOauthClient(client(), {
    clientName: "ChatGPT",
    redirectUris: [redirectUri],
  });
  return { setup, oauthClient };
}

describe("instance-local MCP OAuth", () => {
  it("exchanges a single-use PKCE code for resource-bound workspace tokens", async () => {
    const { setup, oauthClient } = await fixture();
    const authorization = await issueMcpOauthAuthorizationCode(client(), {
      clientId: oauthClient.clientId,
      userId: setup.owner.id,
      workspaceId: setup.workspace.id,
      redirectUri,
      codeChallenge: challenge,
      scope: MCP_OAUTH_SCOPE,
      resource,
    });

    const tokens = await exchangeMcpOauthAuthorizationCode(client(), {
      clientId: oauthClient.clientId,
      code: authorization.code,
      redirectUri,
      codeVerifier: verifier,
      resource,
    });

    expect(tokens).toMatchObject({
      access_token: expect.stringMatching(/^doco_at_/),
      refresh_token: expect.stringMatching(/^doco_rt_/),
      token_type: "Bearer",
      scope: MCP_OAUTH_SCOPE,
    });
    expect(await authenticateMcpToken(client(), tokens.access_token, resource)).toMatchObject({
      userId: setup.owner.id,
      workspaceId: setup.workspace.id,
      role: "owner",
      label: "ChatGPT",
    });
    const stored = await db.query<{ resource: string; scope: string }>(
      "SELECT resource, scope FROM oauth_access_tokens WHERE client_id = $1",
      [oauthClient.clientId],
    );
    expect(stored.rows).toEqual([{ resource, scope: MCP_OAUTH_SCOPE }]);

    await expect(
      exchangeMcpOauthAuthorizationCode(client(), {
        clientId: oauthClient.clientId,
        code: authorization.code,
        redirectUri,
        codeVerifier: verifier,
        resource,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rotates refresh tokens and revokes the whole OAuth connection", async () => {
    const { setup, oauthClient } = await fixture();
    const authorization = await issueMcpOauthAuthorizationCode(client(), {
      clientId: oauthClient.clientId,
      userId: setup.owner.id,
      workspaceId: setup.workspace.id,
      redirectUri,
      codeChallenge: challenge,
      scope: MCP_OAUTH_SCOPE,
      resource,
    });
    const first = await exchangeMcpOauthAuthorizationCode(client(), {
      clientId: oauthClient.clientId,
      code: authorization.code,
      redirectUri,
      codeVerifier: verifier,
      resource,
    });

    const refreshed = await refreshMcpOauthTokens(client(), {
      clientId: oauthClient.clientId,
      refreshToken: first.refresh_token,
      resource,
    });
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(refreshed.refresh_token).not.toBe(first.refresh_token);
    await expect(
      refreshMcpOauthTokens(client(), {
        clientId: oauthClient.clientId,
        refreshToken: first.refresh_token,
        resource,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const listed = await listMcpTokens(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.label).toBe("ChatGPT");
    await revokeMcpToken(client(), {
      tokenId: listed[0]?.tokenId ?? "missing",
      userId: setup.owner.id,
    });
    await expect(authenticateMcpToken(client(), first.access_token, resource)).resolves.toBeNull();
    await expect(
      authenticateMcpToken(client(), refreshed.access_token, resource),
    ).resolves.toBeNull();
    await expect(
      refreshMcpOauthTokens(client(), {
        clientId: oauthClient.clientId,
        refreshToken: refreshed.refresh_token,
        resource,
      }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("rejects unsafe redirect URIs and a mismatched resource", async () => {
    await expect(
      registerMcpOauthClient(client(), {
        clientName: "Unsafe",
        redirectUris: ["javascript:alert(document.domain)"],
      }),
    ).rejects.toBeInstanceOf(McpOauthError);

    const { setup, oauthClient } = await fixture();
    const authorization = await issueMcpOauthAuthorizationCode(client(), {
      clientId: oauthClient.clientId,
      userId: setup.owner.id,
      workspaceId: setup.workspace.id,
      redirectUri,
      codeChallenge: challenge,
      scope: MCP_OAUTH_SCOPE,
      resource,
    });
    await expect(
      exchangeMcpOauthAuthorizationCode(client(), {
        clientId: oauthClient.clientId,
        code: authorization.code,
        redirectUri,
        codeVerifier: verifier,
        resource: "https://another-instance.example/mcp",
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("rejects a resource-less OAuth token imported from another instance", async () => {
    const { setup, oauthClient } = await fixture();
    const foreignToken = "doco_at_resource_less_foreign_instance_token";
    await db.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, user_id, token_name, granted_collection_ids,
          granted_workspace_ids, granted_workspace_roles, granted_workspace_write_types,
          grant_type, expires_at)
       VALUES ($1, $2, $3, 'Imported OAuth client', ARRAY[]::text[], ARRAY[$4]::text[],
               $5::jsonb, $6::jsonb, 'regular', now() + interval '1 hour')`,
      [
        createHash("sha256").update(foreignToken).digest("hex"),
        oauthClient.clientId,
        setup.owner.id,
        setup.workspace.id,
        JSON.stringify({ [setup.workspace.id]: "owner" }),
        JSON.stringify({ [setup.workspace.id]: ["*"] }),
      ],
    );

    await expect(authenticateMcpToken(client(), foreignToken, resource)).resolves.toBeNull();
  });
});
