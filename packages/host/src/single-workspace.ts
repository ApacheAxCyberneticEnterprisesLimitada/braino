import type { PoolClient } from "@doco/db";
import { generateUlid, makeEntityId } from "@doco/shared";
import { addWorkspaceByHandle } from "./host.js";

export class SingleWorkspaceAlreadyInitializedError extends Error {
  constructor() {
    super("This Doco deployment already has its workspace.");
    this.name = "SingleWorkspaceAlreadyInitializedError";
  }
}

export class SingleWorkspaceInvariantError extends Error {
  constructor(count: number) {
    super(`A single-workspace Doco deployment cannot contain ${count} workspaces.`);
    this.name = "SingleWorkspaceInvariantError";
  }
}

export interface SingleWorkspace {
  id: string;
  handle: string;
  name: string;
}

export type SingleWorkspaceState =
  | { initialized: false }
  | { initialized: true; workspace: SingleWorkspace };

export interface InitializeSingleWorkspaceInput {
  workspaceHandle: string;
  workspaceName: string;
  ownerEmail: string;
  ownerUsername: string;
  ownerName: string;
  ownerPasswordHash: string;
}

export interface InitializedSingleWorkspace {
  workspace: SingleWorkspace;
  owner: {
    id: string;
    email: string;
    username: string;
    name: string;
  };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export async function getSingleWorkspaceState(client: PoolClient): Promise<SingleWorkspaceState> {
  const result = await client.query<SingleWorkspace>(
    "SELECT id, handle, name FROM workspaces ORDER BY created_at, id",
  );
  if (result.rows.length === 0) return { initialized: false };
  if (result.rows.length > 1) throw new SingleWorkspaceInvariantError(result.rows.length);
  return { initialized: true, workspace: result.rows[0] as SingleWorkspace };
}

export async function initializeSingleWorkspace(
  client: PoolClient,
  input: InitializeSingleWorkspaceInput,
): Promise<InitializedSingleWorkspace> {
  const workspaceHandle = required(input.workspaceHandle, "Workspace handle").toLowerCase();
  const workspaceName = required(input.workspaceName, "Workspace name");
  const ownerEmail = required(input.ownerEmail, "Owner email").toLowerCase();
  const ownerUsername = required(input.ownerUsername, "Owner username").toLowerCase();
  const ownerName = required(input.ownerName, "Owner name");
  const ownerPasswordHash = required(input.ownerPasswordHash, "Owner password hash");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw new Error("Owner email is invalid.");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(ownerUsername)) {
    throw new Error("Owner username must use lowercase letters, numbers, hyphens, or underscores.");
  }

  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('doco_single_workspace_setup'))");
    const state = await getSingleWorkspaceState(client);
    if (state.initialized) throw new SingleWorkspaceAlreadyInitializedError();

    const ownerId = makeEntityId("user", generateUlid());
    await client.query(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
      [ownerId, ownerUsername, ownerName, ownerEmail, ownerPasswordHash],
    );

    const created = await addWorkspaceByHandle(
      { handle: workspaceHandle, ownerUserId: ownerId },
      client,
    );
    await client.query("UPDATE workspaces SET name = $2, updated_at = now() WHERE id = $1", [
      created.id,
      workspaceName,
    ]);
    await client.query("COMMIT");

    return {
      workspace: { id: created.id, handle: created.handle, name: workspaceName },
      owner: {
        id: ownerId,
        email: ownerEmail,
        username: ownerUsername,
        name: ownerName,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
