import { createHash } from "node:crypto";
import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  PluginInstallationError,
  installPlugin,
  listPluginInstallations,
  setPluginInstallationEnabled,
} from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const component = (version: string) => new TextEncoder().encode(`component:${version}`);
const digest = (artifact: Uint8Array) =>
  `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
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
    const artifact = component("one");
    const firstInstallation = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      component: artifact,
    });
    const secondInstallation = await installPlugin(client(), {
      workspaceId: "workspace_second",
      userId: "user_second_owner",
      manifest: manifest(),
      component: artifact,
    });

    expect(firstInstallation).toMatchObject({
      workspaceId: first.workspace.id,
      manifest: { id: "acme.postmark", version: "1.0.0" },
      artifactDigest: digest(artifact),
      enabled: true,
    });
    expect(secondInstallation.workspaceId).toBe("workspace_second");
    expect(secondInstallation.id).not.toBe(firstInstallation.id);
    const artifacts = await db.query<{ count: number; bytes: number }>(
      "SELECT count(*)::int AS count, sum(octet_length(component))::int AS bytes FROM plugin_artifacts",
    );
    expect(artifacts.rows[0]).toEqual({ count: 1, bytes: artifact.byteLength });
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
      component: component("one"),
    });
    const upgraded = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest("2.0.0"),
      component: component("two"),
    });

    expect(upgraded).toMatchObject({
      id: installed.id,
      manifest: { id: "acme.postmark", version: "2.0.0" },
      artifactDigest: digest(component("two")),
      enabled: true,
    });
  });

  it("can disable only an installation from the owner's workspace", async () => {
    const first = await fixture();
    const installed = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      component: component("one"),
    });

    await setPluginInstallationEnabled(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      installationId: installed.id,
      enabled: false,
    });
    await expect(
      listPluginInstallations(client(), {
        workspaceId: first.workspace.id,
        userId: first.owner.id,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: installed.id, enabled: false })]);
  });

  it("keeps installation management owner-only and rejects empty artifacts", async () => {
    const first = await fixture();
    const installed = await installPlugin(client(), {
      workspaceId: first.workspace.id,
      userId: first.owner.id,
      manifest: manifest(),
      component: component("one"),
    });

    await expect(
      installPlugin(client(), {
        workspaceId: first.workspace.id,
        userId: "user_writer",
        manifest: manifest(),
        component: component("untrusted"),
      }),
    ).rejects.toMatchObject({ code: "owner_required", status: 403 });
    await expect(
      installPlugin(client(), {
        workspaceId: first.workspace.id,
        userId: first.owner.id,
        manifest: manifest(),
        component: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: "artifact_invalid" });
    const artifacts = await db.query<{ digest: string }>(
      "SELECT digest FROM plugin_artifacts WHERE digest = $1",
      [digest(component("untrusted"))],
    );
    expect(artifacts.rows).toEqual([]);
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
