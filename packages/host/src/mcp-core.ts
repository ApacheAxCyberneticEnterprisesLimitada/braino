import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "@doco/db";
import { generateUlid } from "@doco/shared";

const MCP_CLIENT_ID = "doco_self_hosted_tokens";
const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface McpPrincipal {
  userId: string;
  workspaceId: string;
  role: "owner" | "writer" | "reader";
  label: string | null;
}

export interface McpTokenSummary {
  tokenId: string;
  label: string | null;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export async function createMcpToken(
  client: PoolClient,
  input: { workspaceId: string; userId: string; label: string },
): Promise<{ accessToken: string; tokenId: string; expiresAt: string }> {
  const membership = await client.query<{ role: McpPrincipal["role"] }>(
    "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
    [input.workspaceId, input.userId],
  );
  const role = membership.rows[0]?.role;
  if (!role) throw new Error("Workspace membership is required to create an MCP token.");
  const label = input.label.trim().slice(0, 100) || "MCP client";
  const accessToken = `doco_at_${randomBytes(32).toString("base64url")}`;
  const tokenId = digest(accessToken);
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO oauth_clients
         (client_id, client_name, redirect_uris, grant_types, response_types)
       VALUES ($1, 'Braino self-hosted MCP tokens', ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[])
       ON CONFLICT (client_id) DO NOTHING`,
      [MCP_CLIENT_ID],
    );
    await client.query(
      `INSERT INTO oauth_access_tokens
         (token, client_id, user_id, token_name, granted_collection_ids,
          granted_workspace_ids, granted_workspace_roles, granted_workspace_write_types,
          grant_type, expires_at)
       VALUES ($1, $2, $3, $4, ARRAY[]::text[], ARRAY[$5]::text[], $6::jsonb, $7::jsonb,
               'regular', $8)`,
      [
        tokenId,
        MCP_CLIENT_ID,
        input.userId,
        label,
        input.workspaceId,
        JSON.stringify({ [input.workspaceId]: role }),
        JSON.stringify({ [input.workspaceId]: role === "reader" ? [] : ["*"] }),
        expiresAt,
      ],
    );
    await client.query("COMMIT");
    return { accessToken, tokenId, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function authenticateMcpToken(
  client: PoolClient,
  accessToken: string,
): Promise<McpPrincipal | null> {
  if (!accessToken.startsWith("doco_at_")) return null;
  const tokenId = digest(accessToken);
  const found = await client.query<{
    user_id: string;
    workspace_id: string;
    role: McpPrincipal["role"];
    label: string | null;
  }>(
    `SELECT t.user_id, t.granted_workspace_ids[1] AS workspace_id,
            wu.role, t.token_name AS label
       FROM oauth_access_tokens t
       JOIN workspace_users wu
         ON wu.user_id = t.user_id
        AND wu.workspace_id = t.granted_workspace_ids[1]
      WHERE t.token = $1 AND NOT t.revoked AND t.expires_at > now()
        AND cardinality(t.granted_workspace_ids) = 1`,
    [tokenId],
  );
  const row = found.rows[0];
  if (!row) return null;
  await client.query("UPDATE oauth_access_tokens SET last_used_at = now() WHERE token = $1", [
    tokenId,
  ]);
  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    role: row.role,
    label: row.label,
  };
}

export async function listMcpTokens(
  client: PoolClient,
  input: { workspaceId: string; userId: string },
): Promise<McpTokenSummary[]> {
  const found = await client.query<{
    token: string;
    token_name: string | null;
    expires_at: Date | string;
    created_at: Date | string;
    last_used_at: Date | string | null;
    revoked: boolean;
  }>(
    `SELECT token, token_name, expires_at, created_at, last_used_at, revoked
       FROM oauth_access_tokens
      WHERE user_id = $1 AND $2 = ANY(granted_workspace_ids)
      ORDER BY created_at DESC`,
    [input.userId, input.workspaceId],
  );
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return found.rows.map((row) => ({
    tokenId: row.token,
    label: row.token_name,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
    revoked: row.revoked,
  }));
}

export async function revokeMcpToken(
  client: PoolClient,
  input: { tokenId: string; userId: string },
): Promise<void> {
  await client.query(
    "UPDATE oauth_access_tokens SET revoked = true WHERE token = $1 AND user_id = $2",
    [input.tokenId, input.userId],
  );
}

export interface BriefRecord {
  id: string;
  collection_handle: string;
  node_type: string;
  lifecycle: string;
  title: string;
  excerpt: string;
  updated_at: string;
}

export interface WorkspaceBrief {
  brief_id: string;
  result_id: string;
  model: "none";
  workspace: { id: string; handle: string; name: string; constitution: string };
  about: string;
  touching: string[];
  summary: string;
  must_obey: BriefRecord[];
  decided: BriefRecord[];
  in_motion: BriefRecord[];
  background: BriefRecord[];
  display: { found: string };
}

export async function createWorkspaceBrief(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    about: string;
    touching?: string[];
    limit?: number;
  },
): Promise<WorkspaceBrief> {
  const about = input.about.trim();
  if (!about) throw new Error("Brief topic is required.");
  const touching = (input.touching ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  const query = [about, ...touching].join(" ").slice(0, 2_000);
  const limit = Math.max(4, Math.min(50, Math.trunc(input.limit ?? 24)));
  const workspace = await client.query<{
    id: string;
    handle: string;
    name: string;
    constitution: string;
  }>(
    `SELECT w.id, w.handle, w.name, w.constitution
       FROM workspaces w
       JOIN workspace_users wu ON wu.workspace_id = w.id
      WHERE w.id = $1 AND wu.user_id = $2`,
    [input.workspaceId, input.userId],
  );
  const workspaceRow = workspace.rows[0];
  if (!workspaceRow) throw new Error("Workspace membership is required to create a brief.");

  const found = await client.query<BriefRecord>(
    `WITH search AS (SELECT websearch_to_tsquery('english', $2) AS terms)
     SELECT n.id, c.handle AS collection_handle, n.node_type, n.lifecycle,
            coalesce(nullif(n.extra->>'title', ''), nullif(n.extra->>'name', ''),
                     nullif(split_part(n.prose, E'\n', 1), ''), n.id) AS title,
            left(n.prose, 500) AS excerpt,
            n.updated_at::text
       FROM nodes n
       JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
       JOIN search ON true
      WHERE c.workspace_id = $1
      ORDER BY
        (to_tsvector('english', concat_ws(' ', n.id, n.prose, n.locator,
          n.extra->>'title', n.extra->>'name')) @@ search.terms) DESC,
        ts_rank_cd(to_tsvector('english', concat_ws(' ', n.id, n.prose, n.locator,
          n.extra->>'title', n.extra->>'name')), search.terms) DESC,
        CASE n.node_type WHEN 'rule' THEN 0 WHEN 'decision' THEN 1 ELSE 2 END,
        n.updated_at DESC, n.id
      LIMIT $3`,
    [input.workspaceId, query, limit],
  );
  const policies = await client.query<BriefRecord>(
    `WITH search AS (SELECT websearch_to_tsquery('english', $2) AS terms)
     SELECT p.id, c.handle AS collection_handle, 'policy'::text AS node_type,
            p.lifecycle,
            coalesce(nullif(p.data->>'policy', ''), nullif(p.data->'predicate'->>'spec', ''),
                     p.id) AS title,
            left(p.data::text, 500) AS excerpt,
            p.updated_at::text
       FROM policies p
       JOIN collections c ON c.id = p.collection_id AND c.deleted_at IS NULL
       JOIN search ON true
      WHERE c.workspace_id = $1 AND p.lifecycle = 'active'
        AND to_tsvector('english', concat_ws(' ', p.data->>'policy',
              p.data->'predicate'->>'spec', p.data::text)) @@ search.terms
      ORDER BY ts_rank_cd(to_tsvector('english', concat_ws(' ', p.data->>'policy',
                 p.data->'predicate'->>'spec', p.data::text)), search.terms) DESC,
               p.updated_at DESC, p.id
      LIMIT 10`,
    [input.workspaceId, query],
  );
  const mustObey = [...policies.rows, ...found.rows.filter((row) => row.node_type === "rule")];
  const decided = found.rows.filter((row) => row.node_type === "decision");
  const moving = new Set(["action", "intent", "idea", "state", "eval"]);
  const inMotion = found.rows.filter((row) => moving.has(row.node_type));
  const background = found.rows.filter(
    (row) => row.node_type !== "rule" && row.node_type !== "decision" && !moving.has(row.node_type),
  );
  const briefId = `brief_${generateUlid()}`;
  const resultId = `result_${generateUlid()}`;
  const resultIds = [...policies.rows, ...found.rows].map((row) => row.id);
  await client.query(
    `INSERT INTO query_events (actor, workspace_id, source, metadata)
     VALUES ($1, $2, 'mcp', $3::jsonb)`,
    [input.userId, input.workspaceId, JSON.stringify({ brief_id: briefId, touching })],
  );
  await client.query(
    `INSERT INTO agent_results
       (id, actor, tool, query, result_ids, source, metadata, context)
     VALUES ($1, $2, 'doco_brief', $3, $4, 'mcp', $5::jsonb, $6::jsonb)`,
    [
      resultId,
      input.userId,
      about,
      resultIds,
      JSON.stringify({ brief_id: briefId, touching }),
      JSON.stringify({ model: "none", workspace_id: input.workspaceId }),
    ],
  );
  const summary = `${resultIds.length} records selected from ${workspaceRow.name}; deterministic PostgreSQL ranking, no model used.`;
  return {
    brief_id: briefId,
    result_id: resultId,
    model: "none",
    workspace: workspaceRow,
    about,
    touching,
    summary,
    must_obey: mustObey,
    decided,
    in_motion: inMotion,
    background,
    display: { found: `Braino brief · ${resultIds.length} records · ${workspaceRow.handle}` },
  };
}

export async function recordBriefFeedback(
  client: PoolClient,
  input: {
    resultId: string;
    userId: string;
    relevant: boolean;
    betterAnswerFound: boolean;
    betterAnswer?: string;
    betterAnswerSource?: string;
  },
): Promise<void> {
  const updated = await client.query(
    `UPDATE agent_results
        SET relevant = $3, better_answer_found = $4,
            better_answer = $5, better_answer_source = $6, feedback_at = now()
      WHERE id = $1 AND actor = $2
      RETURNING id`,
    [
      input.resultId,
      input.userId,
      input.relevant,
      input.betterAnswerFound,
      input.betterAnswerFound ? (input.betterAnswer?.trim() ?? "") : "",
      input.betterAnswerFound ? (input.betterAnswerSource?.trim() ?? "") : "",
    ],
  );
  if (!updated.rows[0]) throw new Error("Brief result not found.");
}
