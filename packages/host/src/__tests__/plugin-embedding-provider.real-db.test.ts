import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { resolveWorkspaceEmbeddingProvider } from "../plugin-embedding-provider.js";
import { configurePluginInstallation, installPlugin } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "plugin-embedding-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";

const manifest: PluginManifest = {
  protocolVersion: 1,
  id: "braino.ollama-embedding",
  name: "Ollama embeddings",
  version: "0.1.0",
  capabilities: ["embedding.embed"],
  permissions: { network: ["ollama:11434"] },
  configurationSchema: {
    type: "object",
    properties: { model: { type: "string" }, dimensions: { type: "string" } },
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
  const installation = await installPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    manifest,
    component: new TextEncoder().encode("ollama component"),
  });
  await configurePluginInstallation(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    installationId: installation.id,
    configuration: { model: "embeddinggemma", dimensions: "3" },
    secrets: {},
    encryptionKey,
  });
  return { ...setup, installation };
}

describe("workspace embedding plugin", () => {
  it("adapts the enabled workspace installation to the canonical embedding provider", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async () =>
      Response.json({
        outputJson: JSON.stringify({
          model: "ollama:embeddinggemma",
          dimensions: 3,
          vectors: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
        }),
      }),
    ) as typeof fetch;

    const provider = await resolveWorkspaceEmbeddingProvider(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken },
      fetcher,
    });

    expect(provider).not.toBeNull();
    expect(provider).toMatchObject({
      modelId: "plugin:braino.ollama-embedding:embeddinggemma",
      dimensions: 3,
    });
    const vectors = await provider?.embed(["first", "second"], "document");
    expect(vectors?.map((vector) => Array.from(vector))).toEqual([
      [expect.closeTo(0.1, 5), expect.closeTo(0.2, 5), expect.closeTo(0.3, 5)],
      [expect.closeTo(0.4, 5), expect.closeTo(0.5, 5), expect.closeTo(0.6, 5)],
    ]);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const envelope = JSON.parse(String(init.body));
    expect(JSON.parse(envelope.inputJson)).toEqual({
      model: "embeddinggemma",
      inputs: ["first", "second"],
      inputType: "document",
    });
  });

  it("returns null when the workspace has no enabled embedding plugin", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "empty",
      workspaceName: "Empty",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });

    await expect(
      resolveWorkspaceEmbeddingProvider(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
      }),
    ).resolves.toBeNull();
  });

  it("rejects malformed plugin output before it can enter the vector store", async () => {
    const setup = await fixture();
    const provider = await resolveWorkspaceEmbeddingProvider(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken },
      fetcher: vi.fn(async () =>
        Response.json({
          outputJson: JSON.stringify({
            model: "ollama:embeddinggemma",
            dimensions: 3,
            vectors: [[0.1, Number.NaN, 0.3]],
          }),
        }),
      ) as typeof fetch,
    });

    await expect(provider?.embed(["unsafe"], "query")).rejects.toThrow("invalid embedding vectors");
  });
});
