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
