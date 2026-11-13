import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  PluginInstallationError,
  configurePluginInstallation,
  installPlugin,
  listPluginSecretNames,
} from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "plugin-secret-test-key-with-more-than-thirty-two-characters";
const component = new TextEncoder().encode("postmark component");
const manifest: PluginManifest = {
  protocolVersion: 1,
  id: "acme.postmark",
  name: "Postmark",
  version: "1.0.0",
  capabilities: ["email.send", "event.receive"],
  permissions: { network: ["api.postmarkapp.com"] },
  configurationSchema: {
    type: "object",
    properties: { from: { type: "string" } },
    additionalProperties: false,
  },
  secretSchema: {
    type: "object",
    properties: {
      server_token: { type: "string" },
      webhook_secret: { type: "string" },
    },
    additionalProperties: false,
  },
};

async function fixture() {
  const initialized = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  await db.query(
    `INSERT INTO workspaces (id, handle, name, constitution)
     VALUES ('workspace_second', 'second', 'Second', '')`,
  );
  await db.query(
    `INSERT INTO users (id, username, name, email, password_hash, data)
     VALUES ('user_second_owner', 'second-owner', 'Second Owner',
             'second@example.com', 'hash', '{}')`,
  );
  await db.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role)
     VALUES ('workspace_second', 'user_second_owner', 'owner')`,
  );
  const installation = await installPlugin(client(), {
    workspaceId: initialized.workspace.id,
    userId: initialized.owner.id,
    manifest,
    component,
  });
  return { ...initialized, installation };
}

describe("workspace-bound plugin secrets", () => {
  it("stores configuration and sealed secrets without returning their values", async () => {
    const setup = await fixture();
    const configured = await configurePluginInstallation(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: setup.installation.id,
      configuration: { from: "braino@example.com" },
      secrets: {
        server_token: "postmark-server-token",
        webhook_secret: "postmark-webhook-secret",
      },
      encryptionKey,
    });

    expect(configured).toEqual({
      installation: expect.objectContaining({
        id: setup.installation.id,
        configuration: { from: "braino@example.com" },
      }),
      secretNames: ["server_token", "webhook_secret"],
    });
    await expect(
      listPluginSecretNames(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        installationId: setup.installation.id,
      }),
    ).resolves.toEqual(["server_token", "webhook_secret"]);
    const stored = await db.query<{ value_sealed: string }>(
      "SELECT value_sealed FROM plugin_installation_secrets ORDER BY name",
    );
    expect(stored.rows).toHaveLength(2);
    expect(JSON.stringify(stored.rows)).not.toContain("postmark-server-token");
    expect(JSON.stringify(stored.rows)).not.toContain("postmark-webhook-secret");
  });

  it("replaces and removes individual secrets without exposing another value", async () => {
    const setup = await fixture();
    await configurePluginInstallation(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: setup.installation.id,
      configuration: {},
      secrets: {
        server_token: "old-token",
        webhook_secret: "old-secret",
      },
      encryptionKey,
    });
    const original = await db.query<{ value_sealed: string }>(
      `SELECT value_sealed
         FROM plugin_installation_secrets
        WHERE installation_id = $1 AND name = 'server_token'`,
      [setup.installation.id],
    );
    await configurePluginInstallation(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: setup.installation.id,
      configuration: {},
      secrets: { server_token: "new-token", webhook_secret: null },
      encryptionKey,
    });
    const replaced = await db.query<{ value_sealed: string }>(
      `SELECT value_sealed
         FROM plugin_installation_secrets
        WHERE installation_id = $1 AND name = 'server_token'`,
      [setup.installation.id],
    );

    expect(replaced.rows[0]?.value_sealed).not.toBe(original.rows[0]?.value_sealed);
    await expect(
      listPluginSecretNames(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        installationId: setup.installation.id,
      }),
    ).resolves.toEqual(["server_token"]);
  });

  it("rejects undeclared configuration and secret names", async () => {
    const setup = await fixture();

    await expect(
      configurePluginInstallation(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        installationId: setup.installation.id,
        configuration: { another_workspace: "workspace_second" },
        secrets: {},
        encryptionKey,
      }),
    ).rejects.toMatchObject({ code: "configuration_not_declared" });
    await expect(
      configurePluginInstallation(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        installationId: setup.installation.id,
        configuration: {},
        secrets: { another_workspace_token: "secret" },
        encryptionKey,
      }),
    ).rejects.toBeInstanceOf(PluginInstallationError);
  });

  it("keeps runtime configuration string-valued like the component ABI", async () => {
    const setup = await fixture();

    await expect(
      configurePluginInstallation(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        installationId: setup.installation.id,
        configuration: { from: 42 },
        secrets: {},
        encryptionKey,
      }),
    ).rejects.toMatchObject({ code: "configuration_value_invalid" });
  });
});
