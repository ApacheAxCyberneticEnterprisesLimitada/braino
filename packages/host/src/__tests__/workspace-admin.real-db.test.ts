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
        timesPublic: false,
        timesTimeZone: "America/Los_Angeles",
      },
      counts: {
        collections: 9,
        records: 0,
        collaborators: 1,
        connections: 0,
        mcpTokens: 0,
      },
      activity: {
        period: "24h",
        activeAgents: { current: 0, previous: 0 },
        queries: { current: 0, previous: 0, byAgents: 0 },
        writes: { current: 0, previous: 0, byAgents: 0 },
        imports: { current: 0, previous: 0 },
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
       ($1, $2, 'mcp', '{"client":"Previous week agent"}', $3::timestamptz - interval '10 days'),
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
          $2::timestamptz - interval '32 hours'),
         ('reference_previous_week_import', $1, 'reference', 'active', 'Previous week pull request',
          'https://github.com/acme/widgets/pull/3', $2::timestamptz - interval '10 days',
          $2::timestamptz - interval '10 days')`,
      [collectionId, NOW.toISOString()],
    );

    const overview = await getWorkspaceAdminOverview(client(), {
      workspaceId: initialized.workspace.id,
      userId: initialized.owner.id,
      now: NOW,
    });

    expect(overview.activity).toEqual({
      period: "24h",
      activeAgents: { current: 3, previous: 2 },
      queries: { current: 3, previous: 1, byAgents: 2 },
      writes: { current: 2, previous: 1, byAgents: 1 },
      imports: { current: 1, previous: 1 },
    });

    const weekly = await getWorkspaceAdminOverview(client(), {
      workspaceId: initialized.workspace.id,
      userId: initialized.owner.id,
      period: "7d",
      now: NOW,
    });
    expect(weekly.activity).toEqual({
      period: "7d",
      activeAgents: { current: 5, previous: 1 },
      queries: { current: 5, previous: 1, byAgents: 4 },
      writes: { current: 4, previous: 0, byAgents: 3 },
      imports: { current: 2, previous: 1 },
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
        timesPublic: true,
        timesTimeZone: "Africa/Lagos",
      }),
    ).resolves.toEqual({
      id: initialized.workspace.id,
      handle: "acme",
      name: "Acme Research",
      constitution: "Evidence before opinion.",
      timesPublic: true,
      timesTimeZone: "Africa/Lagos",
    });

    const stored = await db.query<{
      handle: string;
      name: string;
      constitution: string;
      times_public: boolean;
      times_timezone: string;
    }>(
      `SELECT handle, name, constitution, times_public, times_timezone
         FROM workspaces WHERE id = $1`,
      [initialized.workspace.id],
    );
    expect(stored.rows[0]).toEqual({
      handle: "acme",
      name: "Acme Research",
      constitution: "Evidence before opinion.",
      times_public: true,
      times_timezone: "Africa/Lagos",
    });
  });

  it("rejects an invalid Braino Times timezone", async () => {
    const initialized = await initializedWorkspace();

    await expect(
      updateWorkspaceSettings(client(), {
        workspaceId: initialized.workspace.id,
        userId: initialized.owner.id,
        name: "Acme",
        constitution: "",
        timesPublic: false,
        timesTimeZone: "Mars/Olympus_Mons",
      }),
    ).rejects.toMatchObject({ code: "invalid_times_timezone", status: 400 });
  });
});
