import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  PluginInstallationError,
  installPlugin,
  listPluginInstallations,
  resolvePluginInvocation,
  setPluginInstallationEnabled,
} from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const manifest = (version = "1.0.0"): PluginManifest => ({
  protocolVersion: 1,
  id: "acme.postmark",
  name: "Postmark",
  version,
  capabilities: ["email.send"],
  permissions: { network: ["api.postmarkapp.com"] },
});

async function fixture() {
  const first = await initializeSingleWorkspace(client(), {
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
             'second@example.com', 'hash', '{}'),
            ('user_writer', 'writer', 'Writer', 'writer@example.com', 'hash', '{}')`,
  );
  await db.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role)
     VALUES ('workspace_second', 'user_second_owner', 'owner'),
            ($1, 'user_writer', 'writer')`,
    [first.workspace.id],
  );
  return first;
}

describe("workspace-bound plugin installations", () => {
  it("installs the same artifact independently in two workspaces", async () => {
    const first = await fixture();
    const firstInstallation = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      artifactDigest: digest("a"),
    });
    const secondInstallation = await installPlugin(client(), {
      workspaceId: "workspace_second",
      userId: "user_second_owner",
      manifest: manifest(),
      artifactDigest: digest("a"),
    });

    expect(firstInstallation).toMatchObject({
      workspaceId: first.workspace.id,
      manifest: { id: "acme.postmark", version: "1.0.0" },
      artifactDigest: digest("a"),
      enabled: true,
    });
    expect(secondInstallation.workspaceId).toBe("workspace_second");
    expect(secondInstallation.id).not.toBe(firstInstallation.id);
    await expect(
      listPluginInstallations(client(), {
        workspaceId: first.workspace.id,
        userId: first.owner.id,
      }),
    ).resolves.toEqual([firstInstallation]);
  });

  it("upgrades one installation in place without changing its identity", async () => {
    const first = await fixture();
    const installed = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      artifactDigest: digest("a"),
    });
    const upgraded = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest("2.0.0"),
      artifactDigest: digest("b"),
    });

    expect(upgraded).toMatchObject({
      id: installed.id,
      manifest: { id: "acme.postmark", version: "2.0.0" },
      artifactDigest: digest("b"),
      enabled: true,
    });
  });

  it("resolves an invocation only inside the installation workspace", async () => {
    const first = await fixture();
    const installed = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      artifactDigest: digest("a"),
    });

    await expect(
      resolvePluginInvocation(client(), {
        workspaceId: first.workspace.id,
        installationId: installed.id,
        capability: "email.send",
      }),
    ).resolves.toEqual({
      workspaceId: first.workspace.id,
      installationId: installed.id,
      pluginId: "acme.postmark",
      pluginVersion: "1.0.0",
      artifactDigest: digest("a"),
      capability: "email.send",
      networkHosts: ["api.postmarkapp.com"],
    });

    await expect(
      resolvePluginInvocation(client(), {
        workspaceId: "workspace_second",
        installationId: installed.id,
        capability: "email.send",
      }),
    ).rejects.toMatchObject({ code: "installation_unavailable", status: 404 });
  });

  it("rejects unapproved capabilities and disabled installations", async () => {
    const first = await fixture();
    const installed = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      artifactDigest: digest("a"),
    });

    await expect(
      resolvePluginInvocation(client(), {
        workspaceId: first.workspace.id,
        installationId: installed.id,
        capability: "source.pull",
      }),
    ).rejects.toMatchObject({ code: "capability_not_approved", status: 403 });

    await setPluginInstallationEnabled(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      installationId: installed.id,
      enabled: false,
    });
    await expect(
      resolvePluginInvocation(client(), {
        workspaceId: first.workspace.id,
        installationId: installed.id,
        capability: "email.send",
      }),
    ).rejects.toMatchObject({ code: "installation_unavailable", status: 404 });
  });

  it("keeps installation management owner-only and validates artifact digests", async () => {
    const first = await fixture();
    const installed = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      artifactDigest: digest("a"),
    });

    await expect(
      installPlugin(client(), {
        workspaceId: first.workspace.id,
        userId: "user_writer",
        manifest: manifest(),
        artifactDigest: digest("a"),
      }),
    ).rejects.toMatchObject({ code: "owner_required", status: 403 });
    await expect(
      installPlugin(client(), {
        workspaceId: first.workspace.id,
        userId: first.owner.id,
        manifest: manifest(),
        artifactDigest: "latest",
      }),
    ).rejects.toBeInstanceOf(PluginInstallationError);
    await expect(
      setPluginInstallationEnabled(client(), {
        workspaceId: "workspace_second",
        userId: "user_second_owner",
        installationId: installed.id,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: "installation_unavailable", status: 404 });
  });
});
