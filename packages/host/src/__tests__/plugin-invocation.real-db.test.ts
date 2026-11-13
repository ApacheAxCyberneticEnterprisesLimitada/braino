import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  configurePluginInstallation,
  installPlugin,
  setPluginInstallationEnabled,
} from "../plugin-installations.js";
import { invokePlugin } from "../plugin-invocation.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "plugin-invocation-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";
const component = new TextEncoder().encode("postmark component bytes");
const manifest: PluginManifest = {
  protocolVersion: 1,
  id: "acme.postmark",
  name: "Postmark",
  version: "1.0.0",
  capabilities: ["email.send"],
  permissions: { network: ["api.postmarkapp.com"] },
  configurationSchema: {
    type: "object",
    properties: { from: { type: "string" } },
    additionalProperties: false,
  },
  secretSchema: {
    type: "object",
    properties: { server_token: { type: "string" } },
    additionalProperties: false,
  },
};

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
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
  const installation = await installPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    manifest,
    component,
  });
  await configurePluginInstallation(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    installationId: installation.id,
    configuration: { from: "braino@example.com" },
    secrets: { server_token: "workspace-secret" },
    encryptionKey,
  });
  return { ...setup, installation };
}

describe("workspace-authorized plugin invocation", () => {
  it("sends one complete workspace-bound envelope to the private host", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async () =>
      Response.json({ outputJson: JSON.stringify({ externalId: "message-1" }) }),
    ) as typeof fetch;

    await expect(
      invokePlugin(client(), {
        workspaceId: setup.workspace.id,
        installationId: setup.installation.id,
        capability: "email.send",
        input: { to: ["person@example.com"], subject: "Hello" },
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
        fetcher,
      }),
    ).resolves.toEqual({ externalId: "message-1" });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://plugin-host:8080/v1/invocations");
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: setup.workspace.id,
      installationId: setup.installation.id,
      pluginId: "acme.postmark",
      pluginVersion: "1.0.0",
      artifactDigest: setup.installation.artifactDigest,
      componentBase64: Buffer.from(component).toString("base64"),
      capability: "email.send",
      inputJson: JSON.stringify({ to: ["person@example.com"], subject: "Hello" }),
      configuration: { from: "braino@example.com" },
      secrets: { server_token: "workspace-secret" },
      networkHosts: ["api.postmarkapp.com"],
    });
  });

  it("cannot resolve another workspace's installation or contact the host", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async () => {
      throw new Error("the host must not be contacted");
    }) as typeof fetch;

    await expect(
      invokePlugin(client(), {
        workspaceId: "workspace_second",
        installationId: setup.installation.id,
        capability: "email.send",
        input: {},
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "installation_unavailable", status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unapproved capabilities and disabled installations before execution", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async () => {
      throw new Error("the host must not be contacted");
    }) as typeof fetch;

    await expect(
      invokePlugin(client(), {
        workspaceId: setup.workspace.id,
        installationId: setup.installation.id,
        capability: "source.pull",
        input: {},
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "capability_not_approved", status: 403 });
    await setPluginInstallationEnabled(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: setup.installation.id,
      enabled: false,
    });
    await expect(
      invokePlugin(client(), {
        workspaceId: setup.workspace.id,
        installationId: setup.installation.id,
        capability: "email.send",
        input: {},
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "installation_unavailable", status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not relay an untrusted plugin error message", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "plugin_error",
            message: "workspace-secret",
          },
        },
        { status: 422 },
      ),
    ) as typeof fetch;

    const result = invokePlugin(client(), {
      workspaceId: setup.workspace.id,
      installationId: setup.installation.id,
      capability: "email.send",
      input: {},
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken },
      fetcher,
    });
    await expect(result).rejects.toMatchObject({
      message: "Plugin execution failed.",
      code: "plugin_error",
      status: 422,
    });
    await expect(result).rejects.not.toThrow("workspace-secret");
  });
});
