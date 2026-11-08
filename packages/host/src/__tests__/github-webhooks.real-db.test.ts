import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  configureGithubWebhook,
  connectGithubRepository,
  deliverGithubWebhook,
  listGithubConnections,
} from "../github-connections.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "github-webhook-test-key-with-more-than-thirty-two-characters";
const accessToken = "github_pat_webhook-test-never-store-plaintext";

async function fixture() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

function fakeGithub(capture: { webhookSecret?: string; webhookUrl?: string }): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    if (url.pathname === "/repos/acme/widgets" && (!init?.method || init.method === "GET")) {
      return Response.json({ full_name: "acme/widgets", default_branch: "main" });
    }
    if (url.pathname === "/repos/acme/widgets/hooks" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        config: { secret: string; url: string; content_type: string; insecure_ssl: string };
        events: string[];
        active: boolean;
      };
      capture.webhookSecret = body.config.secret;
      capture.webhookUrl = body.config.url;
      expect(body).toMatchObject({
        config: { content_type: "json", insecure_ssl: "0" },
        events: ["issues", "pull_request"],
        active: true,
      });
      return Response.json({ id: 4242, active: true }, { status: 201 });
    }
    if (url.pathname === "/repos/acme/widgets/issues") {
      return Response.json([
        {
          number: 17,
          title: "Webhook-triggered issue",
          body: "Imported without pressing Sync now.",
          html_url: "https://github.com/acme/widgets/issues/17",
          state: "open",
          created_at: "2026-11-01T10:00:00Z",
          updated_at: "2026-11-01T10:00:00Z",
          user: { login: "octo" },
          labels: [],
          comments: 0,
          locked: false,
        },
      ]);
    }
    if (url.pathname === "/repos/acme/widgets/pulls") {
      return Response.json([
        {
          number: 23,
          title: "Automatic refresh",
          body: "Refresh from a signed delivery.",
          html_url: "https://github.com/acme/widgets/pull/23",
          state: "open",
          draft: false,
          merged_at: null,
          created_at: "2026-11-01T11:00:00Z",
          updated_at: "2026-11-01T11:00:00Z",
          user: { login: "octo" },
          labels: [],
          head: { ref: "automatic" },
          base: { ref: "main" },
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("automatic GitHub sync", () => {
  it("registers a signed webhook and idempotently refreshes from GitHub deliveries", async () => {
    const setup = await fixture();
    const capture: { webhookSecret?: string; webhookUrl?: string } = {};
    const fetcher = fakeGithub(capture);
    const connection = await connectGithubRepository(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      repository: "acme/widgets",
      accessToken,
      encryptionKey,
      fetcher,
    });

    const configured = await configureGithubWebhook(client(), {
      connectionId: connection.id,
      userId: setup.owner.id,
      publicHost: "https://doco.example.test",
      encryptionKey,
      fetcher,
    });
    expect(configured).toMatchObject({ webhookConfigured: true, webhookUrl: capture.webhookUrl });
    expect(capture.webhookUrl).toBe(
      `https://doco.example.test/api/v1/github/webhooks/${connection.id}`,
    );
    expect(capture.webhookSecret).toBeTruthy();
    const stored = await db.query<{ webhook_secret_sealed: string; webhook_id: string }>(
      "SELECT webhook_secret_sealed, webhook_id::text FROM github_connections WHERE id = $1",
      [connection.id],
    );
    expect(stored.rows[0]?.webhook_secret_sealed).not.toContain(capture.webhookSecret as string);
    expect(stored.rows[0]?.webhook_id).toBe("4242");
    expect(await listGithubConnections(client(), setup.workspace.id, setup.owner.id)).toEqual([
      expect.objectContaining({ webhookConfigured: true }),
    ]);

    const payload = JSON.stringify({ repository: { full_name: "acme/widgets" } });
    const signature = `sha256=${createHmac("sha256", capture.webhookSecret as string)
      .update(payload)
      .digest("hex")}`;
    const first = await deliverGithubWebhook(client(), {
      connectionId: connection.id,
      deliveryId: "delivery-01",
      event: "issues",
      signature,
      body: payload,
      encryptionKey,
      fetcher,
    });
    expect(first).toEqual({
      event: "issues",
      synced: true,
      replayed: false,
      created: 2,
      updated: 0,
      unchanged: 0,
    });
    expect((await db.query("SELECT id FROM nodes")).rows).toHaveLength(2);

    const replay = await deliverGithubWebhook(client(), {
      connectionId: connection.id,
      deliveryId: "delivery-01",
      event: "issues",
      signature,
      body: payload,
      encryptionKey,
      fetcher,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await db.query("SELECT entity_id FROM node_versions")).rows).toHaveLength(2);

    await expect(
      deliverGithubWebhook(client(), {
        connectionId: connection.id,
        deliveryId: "delivery-02",
        event: "pull_request",
        signature: "sha256=deadbeef",
        body: payload,
        encryptionKey,
        fetcher,
      }),
    ).rejects.toMatchObject({ code: "signature_invalid", status: 401 });
  });
});
