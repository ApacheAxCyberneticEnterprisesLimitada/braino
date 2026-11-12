import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "@doco/db";

export const MCP_OAUTH_SCOPE = "braino:mcp";

const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLIENT_ID_PREFIX = "doco_client_";
const CODE_PREFIX = "doco_code_";
const ACCESS_TOKEN_PREFIX = "doco_at_";
const REFRESH_TOKEN_PREFIX = "doco_rt_";

type WorkspaceRole = "owner" | "writer" | "reader";

export class McpOauthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpOauthError";
  }
}

export interface McpOauthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  registeredAt: string;
}

export interface McpOauthTokens {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: typeof MCP_OAUTH_SCOPE;
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function instant(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

const UNSAFE_REDIRECT_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "blob:",
  "about:",
  "vbscript:",
]);

export function isValidMcpOauthRedirectUri(value: string): boolean {
  if (value === "urn:ietf:wg:oauth:2.0:oob") return true;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") return isLoopback(url.hostname);
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !UNSAFE_REDIRECT_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

function assertResource(resource: string): void {
  try {
    const url = new URL(resource);
    const secure = url.protocol === "https:";
    const local = url.protocol === "http:" && isLoopback(url.hostname);
    if (
      (!secure && !local) ||
      url.pathname !== "/mcp" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error();
    }
  } catch {
    throw new McpOauthError("invalid_target", "resource must be this Braino instance's /mcp URL");
  }
}

function assertScope(scope: string): void {
  if (scope !== MCP_OAUTH_SCOPE) {
    throw new McpOauthError("invalid_scope", `scope must be '${MCP_OAUTH_SCOPE}'`);
  }
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(challenge, "base64url");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function transaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function registerMcpOauthClient(
  client: PoolClient,
  input: { clientName?: string; redirectUris: string[] },
): Promise<McpOauthClient> {
  if (!Array.isArray(input.redirectUris) || input.redirectUris.length === 0) {
    throw new McpOauthError("invalid_redirect_uri", "redirect_uris must not be empty");
  }
  if (
    input.redirectUris.length > 10 ||
    input.redirectUris.some((uri) => !isValidMcpOauthRedirectUri(uri))
  ) {
    throw new McpOauthError("invalid_redirect_uri", "redirect_uris contains an unsafe URI");
  }
  const clientId = opaque(CLIENT_ID_PREFIX);
  const clientName = input.clientName?.trim().slice(0, 100) || "MCP client";
  const inserted = await client.query<{
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    registered_at: Date | string;
  }>(
    `INSERT INTO oauth_clients
       (client_id, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method)
     VALUES ($1, $2, $3, ARRAY['authorization_code','refresh_token'], ARRAY['code'], 'none')
     RETURNING client_id, client_name, redirect_uris, registered_at`,
    [clientId, clientName, input.redirectUris],
  );
  const row = inserted.rows[0];
  if (!row) throw new McpOauthError("server_error", "OAuth client registration failed");
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: row.redirect_uris,
    registeredAt: new Date(row.registered_at).toISOString(),
  };
}

export async function getMcpOauthClient(
  client: PoolClient,
  clientId: string,
): Promise<McpOauthClient | null> {
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const found = await client.query<{
    client_id: string;
    client_name: string | null;
    redirect_uris: string[];
    registered_at: Date | string;
  }>(
    `SELECT client_id, client_name, redirect_uris, registered_at
       FROM oauth_clients
      WHERE client_id = $1 AND token_endpoint_auth_method = 'none'`,
    [clientId],
  );
  const row = found.rows[0];
  return row
    ? {
        clientId: row.client_id,
        clientName: row.client_name ?? "MCP client",
        redirectUris: row.redirect_uris,
        registeredAt: new Date(row.registered_at).toISOString(),
      }
    : null;
}

export async function issueMcpOauthAuthorizationCode(
  client: PoolClient,
  input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string;
  },
): Promise<{ code: string; expiresAt: string }> {
  assertScope(input.scope);
  assertResource(input.resource);
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw new McpOauthError("invalid_request", "code_challenge must be PKCE S256");
  }
  const oauthClient = await getMcpOauthClient(client, input.clientId);
  if (!oauthClient) throw new McpOauthError("invalid_client", "unknown client_id");
  if (!oauthClient.redirectUris.includes(input.redirectUri)) {
    throw new McpOauthError("invalid_redirect_uri", "redirect_uri is not registered");
  }
  const membership = await client.query<{ role: WorkspaceRole }>(
    "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
    [input.workspaceId, input.userId],
  );
  const role = membership.rows[0]?.role;
  if (!role) throw new McpOauthError("access_denied", "workspace membership is required");

  const code = opaque(CODE_PREFIX);
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS);
  await client.query(
    `INSERT INTO oauth_authorization_codes
       (code, client_id, user_id, redirect_uri, code_challenge,
        code_challenge_method, granted_collection_ids, granted_workspace_ids,
        granted_workspace_roles, granted_workspace_write_types, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'S256', ARRAY[]::text[], ARRAY[$6]::text[],
             $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      code,
      input.clientId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      input.workspaceId,
      JSON.stringify({ [input.workspaceId]: role }),
      JSON.stringify({ [input.workspaceId]: role === "reader" ? [] : ["*"] }),
      MCP_OAUTH_SCOPE,
      input.resource,
      expiresAt,
    ],
  );
  return { code, expiresAt: expiresAt.toISOString() };
}

async function insertTokenPair(
  client: PoolClient,
  input: {
    clientId: string;
    clientName: string;
    userId: string;
    workspaceId: string;
    role: WorkspaceRole;
    resource: string;
  },
): Promise<McpOauthTokens> {
  const accessToken = opaque(ACCESS_TOKEN_PREFIX);
  const refreshToken = opaque(REFRESH_TOKEN_PREFIX);
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const workspaceRoles = JSON.stringify({ [input.workspaceId]: input.role });
  const workspaceWriteTypes = JSON.stringify({
    [input.workspaceId]: input.role === "reader" ? [] : ["*"],
  });
  await client.query(
    `INSERT INTO oauth_access_tokens
       (token, client_id, user_id, token_name, granted_collection_ids,
        granted_workspace_ids, granted_workspace_roles, granted_workspace_write_types,
        grant_type, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, ARRAY[]::text[], ARRAY[$5]::text[], $6::jsonb, $7::jsonb,
             'regular', $8, $9, $10)`,
    [
      digest(accessToken),
      input.clientId,
      input.userId,
      input.clientName,
      input.workspaceId,
      workspaceRoles,
      workspaceWriteTypes,
      MCP_OAUTH_SCOPE,
      input.resource,
      accessExpiresAt,
    ],
  );
  await client.query(
    `INSERT INTO oauth_refresh_tokens
       (token, client_id, user_id, token_name, granted_collection_ids,
        granted_workspace_ids, granted_workspace_roles, granted_workspace_write_types,
        grant_type, scope, resource, expires_at)
     VALUES ($1, $2, $3, $4, ARRAY[]::text[], ARRAY[$5]::text[], $6::jsonb, $7::jsonb,
             'regular', $8, $9, $10)`,
    [
      digest(refreshToken),
      input.clientId,
      input.userId,
      input.clientName,
      input.workspaceId,
      workspaceRoles,
      workspaceWriteTypes,
      MCP_OAUTH_SCOPE,
      input.resource,
      refreshExpiresAt,
    ],
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: MCP_OAUTH_SCOPE,
  };
}

export async function exchangeMcpOauthAuthorizationCode(
  client: PoolClient,
  input: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  },
): Promise<McpOauthTokens> {
  assertResource(input.resource);
  return transaction(client, async () => {
    const found = await client.query<{
      client_id: string;
      client_name: string | null;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      workspace_id: string;
      role: WorkspaceRole;
      scope: string;
      resource: string;
      expires_at: Date | string;
      consumed_at: Date | string | null;
    }>(
      `SELECT c.client_id, c.client_name, a.user_id, a.redirect_uri, a.code_challenge,
              a.granted_workspace_ids[1] AS workspace_id,
              wu.role, a.scope, a.resource, a.expires_at, a.consumed_at
         FROM oauth_authorization_codes a
         JOIN oauth_clients c ON c.client_id = a.client_id
         JOIN workspace_users wu
           ON wu.user_id = a.user_id
          AND wu.workspace_id = a.granted_workspace_ids[1]
        WHERE a.code = $1
        FOR UPDATE OF a`,
      [input.code],
    );
    const row = found.rows[0];
    if (!row || row.consumed_at || instant(row.expires_at) <= Date.now()) {
      throw new McpOauthError("invalid_grant", "authorization code is invalid or expired");
    }
    if (row.client_id !== input.clientId) {
      throw new McpOauthError("invalid_grant", "client_id does not match the authorization code");
    }
    if (row.redirect_uri !== input.redirectUri) {
      throw new McpOauthError(
        "invalid_grant",
        "redirect_uri does not match the authorization code",
      );
    }
    if (row.resource !== input.resource) {
      throw new McpOauthError("invalid_target", "resource does not match the authorization code");
    }
    assertScope(row.scope);
    if (!verifyPkce(input.codeVerifier, row.code_challenge)) {
      throw new McpOauthError("invalid_grant", "code_verifier does not match code_challenge");
    }
    await client.query("UPDATE oauth_authorization_codes SET consumed_at = now() WHERE code = $1", [
      input.code,
    ]);
    return insertTokenPair(client, {
      clientId: row.client_id,
      clientName: row.client_name ?? "MCP client",
      userId: row.user_id,
      workspaceId: row.workspace_id,
      role: row.role,
      resource: row.resource,
    });
  });
}

export async function refreshMcpOauthTokens(
  client: PoolClient,
  input: { clientId: string; refreshToken: string; resource: string },
): Promise<McpOauthTokens> {
  assertResource(input.resource);
  return transaction(client, async () => {
    const found = await client.query<{
      client_id: string;
      client_name: string | null;
      user_id: string;
      workspace_id: string;
      role: WorkspaceRole;
      scope: string;
      resource: string;
      expires_at: Date | string;
      revoked: boolean;
    }>(
      `SELECT r.client_id, c.client_name, r.user_id,
              r.granted_workspace_ids[1] AS workspace_id,
              wu.role, r.scope, r.resource, r.expires_at, r.revoked
         FROM oauth_refresh_tokens r
         JOIN oauth_clients c ON c.client_id = r.client_id
         JOIN workspace_users wu
           ON wu.user_id = r.user_id
          AND wu.workspace_id = r.granted_workspace_ids[1]
        WHERE r.token = $1
        FOR UPDATE OF r`,
      [digest(input.refreshToken)],
    );
    const row = found.rows[0];
    if (!row || row.revoked || instant(row.expires_at) <= Date.now()) {
      throw new McpOauthError("invalid_grant", "refresh token is invalid or expired");
    }
    if (row.client_id !== input.clientId) {
      throw new McpOauthError("invalid_grant", "client_id does not match the refresh token");
    }
    if (row.resource !== input.resource) {
      throw new McpOauthError("invalid_target", "resource does not match the refresh token");
    }
    assertScope(row.scope);
    await client.query("UPDATE oauth_refresh_tokens SET revoked = true WHERE token = $1", [
      digest(input.refreshToken),
    ]);
    return insertTokenPair(client, {
      clientId: row.client_id,
      clientName: row.client_name ?? "MCP client",
      userId: row.user_id,
      workspaceId: row.workspace_id,
      role: row.role,
      resource: row.resource,
    });
  });
}
