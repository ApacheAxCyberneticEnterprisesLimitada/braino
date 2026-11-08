import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  addWorkspaceCollaborator,
  listWorkspaceCollaborators,
  removeWorkspaceCollaborator,
  updateWorkspaceCollaborator,
} from "../collaborators.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function initialized() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

describe("single-workspace collaborators", () => {
  it("adds a sign-in account with an explicit workspace grant", async () => {
    const setup = await initialized();

    const added = await addWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      email: "writer@example.com",
      username: "writer",
      name: "Workspace Writer",
      passwordHash: "scrypt$writer$key",
      role: "writer",
      writeTypes: [],
    });

    expect(added).toMatchObject({
      email: "writer@example.com",
      username: "writer",
      name: "Workspace Writer",
      role: "writer",
      write_types: ["*"],
    });
    const members = await listWorkspaceCollaborators(client(), setup.workspace.id);
    expect(members).toEqual([
      expect.objectContaining({ id: setup.owner.id, role: "owner" }),
      expect.objectContaining({ id: added.id, role: "writer", write_types: ["*"] }),
    ]);
  });

  it("updates per-type access without accepting unknown grant tokens", async () => {
    const setup = await initialized();
    const added = await addWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      email: "reader@example.com",
      username: "reader",
      name: "Workspace Reader",
      passwordHash: "scrypt$reader$key",
      role: "reader",
      writeTypes: [],
    });

    const updated = await updateWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      userId: added.id,
      role: "reader",
      writeTypes: ["decision", "relates_to", "not-a-type"],
    });

    expect(updated).toMatchObject({
      id: added.id,
      role: "reader",
      write_types: ["decision", "relates_to"],
    });
  });

  it("keeps membership administration with owners and prevents self-lockout", async () => {
    const setup = await initialized();

    await expect(
      addWorkspaceCollaborator(client(), {
        workspaceId: setup.workspace.id,
        actorId: "user_01J00000000000000000000000",
        email: "blocked@example.com",
        username: "blocked",
        name: "Blocked",
        passwordHash: "scrypt$blocked$key",
        role: "reader",
        writeTypes: [],
      }),
    ).rejects.toMatchObject({ code: "owner_required", status: 403 });

    await expect(
      updateWorkspaceCollaborator(client(), {
        workspaceId: setup.workspace.id,
        actorId: setup.owner.id,
        userId: setup.owner.id,
        role: "reader",
        writeTypes: [],
      }),
    ).rejects.toMatchObject({ code: "cannot_change_own_access", status: 409 });

    await expect(
      removeWorkspaceCollaborator(client(), {
        workspaceId: setup.workspace.id,
        actorId: setup.owner.id,
        userId: setup.owner.id,
      }),
    ).rejects.toMatchObject({ code: "cannot_change_own_access", status: 409 });
  });

  it("removes workspace access without deleting the person's account", async () => {
    const setup = await initialized();
    const added = await addWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      email: "former@example.com",
      username: "former",
      name: "Former Collaborator",
      passwordHash: "scrypt$former$key",
      role: "reader",
      writeTypes: [],
    });

    await removeWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      userId: added.id,
    });

    const rows = await db.query<{ users: number; memberships: number }>(
      `SELECT
         (SELECT count(*)::int FROM users WHERE id = $1) AS users,
         (SELECT count(*)::int FROM workspace_users WHERE user_id = $1) AS memberships`,
      [added.id],
    );
    expect(rows.rows[0]).toEqual({ users: 1, memberships: 0 });
  });
});
