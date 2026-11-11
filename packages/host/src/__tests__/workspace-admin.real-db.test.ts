import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  WorkspaceAdminError,
  getWorkspaceAdminOverview,
  updateWorkspaceSettings,
} from "../workspace-admin.js";

let db: PGlite;

const NOW = new Date("2026-11-11T12:00:00.000Z");

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function initializedWorkspace() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

describe("single-workspace administration", () => {
  it("gives the workspace owner an operational overview", async () => {
    const initialized = await initializedWorkspace();

    await expect(
      getWorkspaceAdminOverview(client(), {
        workspaceId: initialized.workspace.id,
        userId: initialized.owner.id,
      }),
    ).resolves.toEqual({
      workspace: {
        id: initialized.workspace.id,
        handle: "acme",
        name: "Acme",
        constitution: expect.any(String),
      },
      counts: {
        collections: 9,
        records: 0,
        collaborators: 1,
        connections: 0,
        mcpTokens: 0,
      },
      activity: {
        activeAgents: {
          last24Hours: 0,
          previous24Hours: 0,
          last7Days: 0,
          last30Days: 0,
        },
        queries: { last24Hours: 0, previous24Hours: 0, byAgentsLast24Hours: 0 },
        writes: { last24Hours: 0, previous24Hours: 0, byAgentsLast24Hours: 0 },
        imports: { last24Hours: 0, previous24Hours: 0 },
      },
    });
  });

  it("reports rolling agent and workspace activity with like-for-like day comparisons", async () => {
    const initialized = await initializedWorkspace();
    const collections = await db.query<{ id: string }>(
      "SELECT id FROM collections WHERE workspace_id = $1 ORDER BY id LIMIT 1",
      [initialized.workspace.id],
    );
    const collectionId = collections.rows[0]?.id;
    if (!collectionId) throw new Error("Expected the initialized workspace to have a collection.");

    await db.query(
      `INSERT INTO query_events (actor, workspace_id, source, metadata, at) VALUES
       ($1, $2, 'mcp', '{"client":"Codex"}', $3::timestamptz - interval '1 hour'),
       ($1, $2, 'api', '{"auth":"bearer","token_name":"Claude"}', $3::timestamptz - interval '2 hours'),
       ($1, $2, 'ui', '{}', $3::timestamptz - interval '3 hours'),
       ($1, $2, 'mcp', '{"client":"Gemini"}', $3::timestamptz - interval '30 hours'),
       ($1, $2, 'mcp', '{"client":"Cursor"}', $3::timestamptz - interval '3 days'),
       ($1, $2, 'mcp', '{"client":"Grok"}', $3::timestamptz - interval '15 days'),
       ($1, $2, 'mcp', '{"client":"Old agent"}', $3::timestamptz - interval '31 days')`,
      [initialized.owner.id, initialized.workspace.id, NOW.toISOString()],
    );
    await db.query(
      `INSERT INTO changesets (collection_id, actor, source, metadata, recorded_at) VALUES
       ($1, $2, 'mcp', '{"client":"Devin"}', $3::timestamptz - interval '4 hours'),
       ($1, $2, 'ui', '{}', $3::timestamptz - interval '5 hours'),
       ($1, $2, 'api', '{"auth":"bearer","token_name":"Claude"}', $3::timestamptz - interval '26 hours'),
       ($1, $2, 'mcp', '{"client":"Codex"}', $3::timestamptz - interval '4 days'),
       ($1, $2, 'mcp', '{"client":"Aider"}', $3::timestamptz - interval '20 days'),
       ($1, $2, 'api', '{}', $3::timestamptz - interval '2 hours')`,
      [collectionId, initialized.owner.id, NOW.toISOString()],
    );
    await db.query(
      `INSERT INTO nodes
         (id, collection_id, node_type, lifecycle, prose, locator, created_at, updated_at)
       VALUES
         ('reference_recent_import', $1, 'reference', 'active', 'Recent pull request',
          'https://github.com/acme/widgets/pull/1', $2::timestamptz - interval '6 hours',
          $2::timestamptz - interval '6 hours'),
         ('reference_previous_import', $1, 'reference', 'active', 'Previous pull request',
          'https://github.com/acme/widgets/pull/2', $2::timestamptz - interval '32 hours',
          $2::timestamptz - interval '32 hours')`,
      [collectionId, NOW.toISOString()],
    );

    const overview = await getWorkspaceAdminOverview(client(), {
      workspaceId: initialized.workspace.id,
      userId: initialized.owner.id,
      now: NOW,
    });

    expect(overview.activity).toEqual({
      activeAgents: {
        last24Hours: 3,
        previous24Hours: 2,
        last7Days: 5,
        last30Days: 7,
      },
      queries: { last24Hours: 3, previous24Hours: 1, byAgentsLast24Hours: 2 },
      writes: { last24Hours: 2, previous24Hours: 1, byAgentsLast24Hours: 1 },
      imports: { last24Hours: 1, previous24Hours: 1 },
    });
  });

  it("keeps the administration surface owner-only", async () => {
    const initialized = await initializedWorkspace();
    await db.query(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ('user_writer', 'writer', 'Writer', 'writer@example.com', 'hash', '{}')`,
    );
    await db.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role)
       VALUES ($1, 'user_writer', 'writer')`,
      [initialized.workspace.id],
    );

    const attempt = getWorkspaceAdminOverview(client(), {
      workspaceId: initialized.workspace.id,
      userId: "user_writer",
    });
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceAdminError);
    await expect(attempt).rejects.toMatchObject({ code: "owner_required", status: 403 });
  });

  it("lets the owner update the workspace identity without changing its handle", async () => {
    const initialized = await initializedWorkspace();

    await expect(
      updateWorkspaceSettings(client(), {
        workspaceId: initialized.workspace.id,
        userId: initialized.owner.id,
        name: "Acme Research",
        constitution: "Evidence before opinion.",
      }),
    ).resolves.toEqual({
      id: initialized.workspace.id,
      handle: "acme",
      name: "Acme Research",
      constitution: "Evidence before opinion.",
    });

    const stored = await db.query<{ handle: string; name: string; constitution: string }>(
      "SELECT handle, name, constitution FROM workspaces WHERE id = $1",
      [initialized.workspace.id],
    );
    expect(stored.rows[0]).toEqual({
      handle: "acme",
      name: "Acme Research",
      constitution: "Evidence before opinion.",
    });
  });
});
