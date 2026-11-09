import {
  type ConnectorAdapter,
  connectConnector,
  initializeSingleWorkspace,
  listConnectorConnections,
  syncConnectorConnection,
} from "@doco/host";
import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { slackConnector } from "../slack.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const scope = <T>(operation: (client: PoolClient) => Promise<T>) => operation(client());
function recordingClient(statements: string[]): PoolClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return db.query(sql, params);
    },
  } as unknown as PoolClient;
}
const recordingScope = (statements: string[]) =>
  (<T>(operation: (client: PoolClient) => Promise<T>) =>
    operation(recordingClient(statements))) as typeof scope;
const encryptionKey = "connector-test-key-with-more-than-thirty-two-characters";
const accessToken = "xoxb-test-only-never-store-plaintext";

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

interface SlackState {
  edited: boolean;
  includeAnnouncement: boolean;
}

function fakeSlack(state: SlackState): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.pathname.endsWith("/auth.test")) {
      return Response.json({
        ok: true,
        team_id: "T_ACME",
        team: "Acme",
        url: "https://acme.slack.com/",
      });
    }
    if (url.pathname.endsWith("/users.list")) {
      return Response.json({
        ok: true,
        members: [
          { id: "U_ALICE", real_name: "Alice Example", profile: { display_name: "alice" } },
          { id: "U_BOB", real_name: "Bob Example", profile: { display_name: "bob" } },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (url.pathname.endsWith("/conversations.list")) {
      return Response.json({
        ok: true,
        channels: [
          {
            id: "C_GENERAL",
            name: "general",
            is_channel: true,
            is_private: false,
            is_archived: false,
            is_shared: false,
          },
          {
            id: "C_PRIVATE",
            name: "leadership",
            is_channel: true,
            is_private: true,
            is_archived: false,
            is_shared: false,
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (url.pathname.endsWith("/conversations.history")) {
      return Response.json({
        ok: true,
        messages: [
          ...(state.includeAnnouncement
            ? [
                {
                  ts: "1761991200.000100",
                  user: "U_ALICE",
                  text: state.edited ? "Launch moved to Tuesday" : "Launch is Monday",
                  edited: state.edited ? { ts: "1762077600.000200" } : undefined,
                },
              ]
            : []),
          {
            ts: "1761994800.000300",
            thread_ts: "1761994800.000300",
            user: "U_BOB",
            text: "What is the rollback plan?",
            reply_count: 1,
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (url.pathname.endsWith("/conversations.replies")) {
      return Response.json({
        ok: true,
        messages: [
          {
            ts: "1761994800.000300",
            thread_ts: "1761994800.000300",
            user: "U_BOB",
            text: "What is the rollback plan?",
          },
          {
            ts: "1761998400.000400",
            thread_ts: "1761994800.000300",
            user: "U_ALICE",
            text: "Restore the last database backup.",
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("self-hosted connectors", () => {
  it("binds one Slack workspace, seals its token, and syncs public messages idempotently", async () => {
    const setup = await fixture();
    const state: SlackState = { edited: false, includeAnnouncement: true };
    const connection = await connectConnector(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential: accessToken,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack(state),
    });

    expect(connection).toMatchObject({
      provider: "slack",
      sourceId: "T_ACME",
      sourceName: "Acme",
      collectionHandle: "acme-slack",
      active: true,
    });
    const stored = await db.query<{ credential_sealed: string }>(
      "SELECT credential_sealed FROM connector_connections WHERE id = $1",
      [connection.id],
    );
    expect(stored.rows[0]?.credential_sealed).not.toContain(accessToken);
    expect(await listConnectorConnections(client(), setup.workspace.id, setup.owner.id)).toEqual([
      expect.objectContaining({ id: connection.id, provider: "slack" }),
    ]);

    const statements: string[] = [];
    const first = await syncConnectorConnection(recordingScope(statements), {
      connectionId: connection.id,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack(state),
    });
    expect(first).toEqual({ created: 3, updated: 0, retired: 0, unchanged: 0 });
    const transaction = statements.findIndex((sql) => sql === "BEGIN");
    const connectionLock = statements.findIndex((sql) =>
      /SELECT \* FROM connector_connections WHERE id = \$1 FOR UPDATE/.test(sql),
    );
    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(connectionLock).toBeGreaterThan(transaction);
    const nodes = await db.query<{
      lifecycle: string;
      prose: string;
      locator: string;
      extra: Record<string, unknown>;
    }>("SELECT lifecycle, prose, locator, extra FROM nodes ORDER BY locator");
    expect(nodes.rows).toHaveLength(3);
    expect(nodes.rows.every((node) => node.lifecycle === "active")).toBe(true);
    expect(nodes.rows.some((node) => node.prose.includes("Launch is Monday"))).toBe(true);
    expect(
      nodes.rows.every((node) => node.locator.startsWith("https://acme.slack.com/archives/")),
    ).toBe(true);
    expect(nodes.rows.every((node) => node.extra.connector_provider === "slack")).toBe(true);

    const replay = await syncConnectorConnection(scope, {
      connectionId: connection.id,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack(state),
    });
    expect(replay).toEqual({ created: 0, updated: 0, retired: 0, unchanged: 3 });

    state.edited = true;
    const changed = await syncConnectorConnection(scope, {
      connectionId: connection.id,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack(state),
    });
    expect(changed).toEqual({ created: 0, updated: 1, retired: 0, unchanged: 2 });
    expect(
      await db.query<{ prose: string }>("SELECT prose FROM nodes WHERE prose LIKE '%Tuesday%'"),
    ).toMatchObject({ rows: [{ prose: expect.stringContaining("Launch moved to Tuesday") }] });

    state.includeAnnouncement = false;
    const removed = await syncConnectorConnection(scope, {
      connectionId: connection.id,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack(state),
    });
    expect(removed).toEqual({ created: 0, updated: 0, retired: 1, unchanged: 2 });
    const retired = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM nodes WHERE prose LIKE '%Launch moved to Tuesday%'",
    );
    expect(retired.rows).toEqual([{ lifecycle: "retired" }]);
  });

  it("rejects binding the same Slack source to a second workspace", async () => {
    const setup = await fixture();
    await connectConnector(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential: accessToken,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack({ edited: false, includeAnnouncement: true }),
    });
    await db.query(
      `INSERT INTO workspaces (id, handle, name, constitution)
       VALUES ('workspace_second', 'second', 'Second', '')`,
    );
    await db.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role)
       VALUES ('workspace_second', $1, 'owner')`,
      [setup.owner.id],
    );

    await expect(
      connectConnector(scope, {
        workspaceId: "workspace_second",
        userId: setup.owner.id,
        credential: accessToken,
        encryptionKey,
        adapter: slackConnector,
        fetcher: fakeSlack({ edited: false, includeAnnouncement: true }),
      }),
    ).rejects.toMatchObject({ code: "source_already_connected", status: 409 });
  });

  it("rejects an unsafe provider identifier before provider I/O", async () => {
    const setup = await fixture();
    let verified = false;
    const adapter = {
      provider: "../unsafe",
      verify: async () => {
        verified = true;
        return { id: "unsafe", name: "Unsafe" };
      },
      async *documents() {},
    } satisfies ConnectorAdapter;

    await expect(
      connectConnector(scope, {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        credential: accessToken,
        encryptionKey,
        adapter,
      }),
    ).rejects.toMatchObject({ code: "provider_invalid", status: 400 });
    expect(verified).toBe(false);
  });

  it("rejects an overlapping pull without holding a database lock during provider I/O", async () => {
    const setup = await fixture();
    const connection = await connectConnector(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential: accessToken,
      encryptionKey,
      adapter: slackConnector,
      fetcher: fakeSlack({ edited: false, includeAnnouncement: true }),
    });
    await db.query(
      `UPDATE connector_connections
          SET sync_token = 'already-running', sync_started_at = now()
        WHERE id = $1`,
      [connection.id],
    );

    await expect(
      syncConnectorConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        adapter: slackConnector,
        fetcher: fakeSlack({ edited: false, includeAnnouncement: true }),
      }),
    ).rejects.toMatchObject({ code: "sync_in_progress", status: 409 });
  });

  it("rejects an oversized streamed document before starting a write transaction", async () => {
    const setup = await fixture();
    const statements: string[] = [];
    let activeScopes = 0;
    const monitoredScope = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
      activeScopes += 1;
      try {
        return await operation(recordingClient(statements));
      } finally {
        activeScopes -= 1;
      }
    };
    const adapter = {
      provider: "slack",
      verify: async () => {
        expect(activeScopes).toBe(0);
        return { id: "T_LARGE", name: "Large source" };
      },
      async *documents() {
        expect(activeScopes).toBe(0);
        yield {
          externalId: "too-large",
          title: "Oversized",
          content: "x".repeat(10 * 1024 * 1024 + 1),
          url: "https://example.test/too-large",
          updatedAt: new Date().toISOString(),
        };
      },
    } satisfies ConnectorAdapter;
    const connection = await connectConnector(monitoredScope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential: accessToken,
      encryptionKey,
      adapter,
      fetcher: (async () => Response.json({})) as typeof fetch,
    });
    statements.length = 0;

    await expect(
      syncConnectorConnection(monitoredScope, {
        connectionId: connection.id,
        encryptionKey,
        adapter,
        fetcher: (async () => Response.json({})) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "source_too_large", status: 422 });
    expect(statements.filter((statement) => statement === "BEGIN")).toHaveLength(1);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM nodes")).rows[0]?.n).toBe(
      0,
    );
  });
});
