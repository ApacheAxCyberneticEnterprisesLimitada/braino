import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { connectConnector, syncConnectorConnection } from "../connectors.js";
import { notionConnector } from "../connectors/notion.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "notion-connector-test-key-with-more-than-thirty-two-characters";
const accessToken = "ntn_test-only-never-store-plaintext";

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

interface NotionState {
  includePage: boolean;
  edited: boolean;
}

function fakeNotion(state: NotionState): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(headers.get("notion-version")).toBe("2026-03-11");
    if (url.pathname === "/v1/users/me") {
      return Response.json({
        object: "user",
        id: "bot_doco",
        name: "Doco",
        type: "bot",
        bot: { workspace_id: "notion_acme", workspace_name: "Acme Wiki" },
      });
    }
    if (url.pathname === "/v1/search") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        page_size: 100,
        filter: { property: "object", value: "page" },
      });
      return Response.json({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: state.includePage
          ? [
              {
                object: "page",
                id: "page_runbook",
                created_time: "2026-11-01T10:00:00.000Z",
                last_edited_time: state.edited
                  ? "2026-11-02T10:00:00.000Z"
                  : "2026-11-01T10:00:00.000Z",
                in_trash: false,
                archived: false,
                url: "https://www.notion.so/page_runbook",
                properties: {
                  Name: {
                    id: "title",
                    type: "title",
                    title: [{ type: "text", plain_text: "Incident runbook" }],
                  },
                  Status: { id: "status", type: "status", status: { name: "Ready" } },
                },
              },
            ]
          : [],
      });
    }
    if (url.pathname === "/v1/blocks/page_runbook/children") {
      return Response.json({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [
          {
            object: "block",
            id: "block_intro",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [
                {
                  type: "text",
                  plain_text: state.edited
                    ? "Page the incident commander immediately."
                    : "Page the incident commander.",
                },
              ],
            },
          },
          {
            object: "block",
            id: "block_details",
            type: "toggle",
            has_children: true,
            toggle: { rich_text: [{ type: "text", plain_text: "Rollback" }] },
          },
        ],
      });
    }
    if (url.pathname === "/v1/blocks/block_details/children") {
      return Response.json({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [
          {
            object: "block",
            id: "block_code",
            type: "code",
            has_children: false,
            code: {
              language: "bash",
              rich_text: [{ type: "text", plain_text: "./restore-backup.sh" }],
            },
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("Notion connector", () => {
  it("imports shared pages with nested block content, then updates and retires them", async () => {
    const setup = await fixture();
    const state: NotionState = { includePage: true, edited: false };
    const connection = await connectConnector(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      credential: accessToken,
      encryptionKey,
      adapter: notionConnector,
      fetcher: fakeNotion(state),
    });
    expect(connection).toMatchObject({
      provider: "notion",
      sourceId: "notion_acme",
      sourceName: "Acme Wiki",
      collectionHandle: "acme-notion",
    });

    expect(
      await syncConnectorConnection(client(), {
        connectionId: connection.id,
        encryptionKey,
        adapter: notionConnector,
        fetcher: fakeNotion(state),
      }),
    ).toEqual({ created: 1, updated: 0, retired: 0, unchanged: 0 });
    const imported = await db.query<{
      prose: string;
      locator: string;
      extra: Record<string, unknown>;
    }>("SELECT prose, locator, extra FROM nodes");
    expect(imported.rows[0]).toMatchObject({
      locator: "https://www.notion.so/page_runbook",
      extra: { connector_provider: "notion", connector_external_id: "page_runbook" },
    });
    expect(imported.rows[0]?.prose).toContain("Incident runbook");
    expect(imported.rows[0]?.prose).toContain("Status: Ready");
    expect(imported.rows[0]?.prose).toContain("Page the incident commander.");
    expect(imported.rows[0]?.prose).toContain("```bash\n./restore-backup.sh\n```");

    state.edited = true;
    expect(
      await syncConnectorConnection(client(), {
        connectionId: connection.id,
        encryptionKey,
        adapter: notionConnector,
        fetcher: fakeNotion(state),
      }),
    ).toEqual({ created: 0, updated: 1, retired: 0, unchanged: 0 });

    state.includePage = false;
    expect(
      await syncConnectorConnection(client(), {
        connectionId: connection.id,
        encryptionKey,
        adapter: notionConnector,
        fetcher: fakeNotion(state),
      }),
    ).toEqual({ created: 0, updated: 0, retired: 1, unchanged: 0 });
    expect((await db.query<{ lifecycle: string }>("SELECT lifecycle FROM nodes")).rows).toEqual([
      { lifecycle: "retired" },
    ]);
  });
});
