import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  SingleWorkspaceAlreadyInitializedError,
  getSingleWorkspaceState,
  initializeSingleWorkspace,
} from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

describe("single-workspace host", () => {
  it("creates the sole workspace, its owner, and the standard collections", async () => {
    await expect(getSingleWorkspaceState(client())).resolves.toEqual({ initialized: false });

    const initialized = await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });

    expect(initialized.workspace).toEqual({
      id: expect.stringMatching(/^workspace_/),
      handle: "acme",
      name: "Acme",
    });
    expect(initialized.owner).toEqual({
      id: expect.stringMatching(/^user_/),
      email: "owner@example.com",
      username: "owner",
      name: "Acme Owner",
    });

    const collections = await db.query<{ handle: string }>(
      "SELECT handle FROM collections ORDER BY handle",
    );
    expect(collections.rows).toHaveLength(10);
    expect(collections.rows).toContainEqual({ handle: "acme-agents-chats" });
    expect(collections.rows).toContainEqual({ handle: "acme-product-decisions" });

    await expect(getSingleWorkspaceState(client())).resolves.toEqual({
      initialized: true,
      workspace: initialized.workspace,
    });
  });

  it("refuses a second workspace without changing the existing installation", async () => {
    await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });

    await expect(
      initializeSingleWorkspace(client(), {
        workspaceHandle: "other",
        workspaceName: "Other",
        ownerEmail: "other@example.com",
        ownerUsername: "other",
        ownerName: "Other Owner",
        ownerPasswordHash: "scrypt$other$key",
      }),
    ).rejects.toBeInstanceOf(SingleWorkspaceAlreadyInitializedError);

    const counts = await db.query<{ workspaces: number; users: number }>(
      `SELECT
         (SELECT count(*)::int FROM workspaces) AS workspaces,
         (SELECT count(*)::int FROM users) AS users`,
    );
    expect(counts.rows[0]).toEqual({ workspaces: 1, users: 1 });
  });
});
