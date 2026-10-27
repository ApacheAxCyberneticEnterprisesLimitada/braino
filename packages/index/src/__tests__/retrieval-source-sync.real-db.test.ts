import type { EmbeddingProviderLike, QueryClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { syncRetrievalSourceBatch } from "../retrieval-source-sync.js";

class FixtureProvider implements EmbeddingProviderLike {
  modelId = "test:retrieval-sources";
  dimensions = 3;
  calls: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }
}

const COLLECTION_ID = "collection_retrieval_sources";
let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('ws_sources', 'sources', 'Sources');
    INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data)
      VALUES ('${COLLECTION_ID}', 'retrieval-sources', 'ws_sources', 'ws_sources', 'private', '{}'::jsonb);

    INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, locator)
      VALUES ('decision_source', '${COLLECTION_ID}', 'decision', 'active',
              'Solar uses JDK 8.', 'https://doco.test/decision_source');

    INSERT INTO notion_mirrors
      (collection_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
      VALUES ('${COLLECTION_ID}', 'notion_ws', 'Acme', 'notion_bot', 'sealed', now());
    INSERT INTO notion_pages
      (collection_id, page_id, object, parent_type, title, url, markdown, plain_text,
       content_hash, fetch_pending, synced_at)
      VALUES ('${COLLECTION_ID}', 'notion_page', 'page', 'workspace', 'Language tests',
              'https://notion.test/language-tests', '# Status', 'Status', 'notion-hash', false, now());

    INSERT INTO group_chat_installations (id, provider, workspace_id, doco_workspace_id)
      VALUES ('slack_install', 'slack', 'T_SOURCES', 'ws_sources');
    INSERT INTO group_chat_mirrors
      (collection_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('${COLLECTION_ID}', 'slack_install', 'acme', now() - interval '1 year', now());
    INSERT INTO group_chat_channels (collection_id, channel_id, name, joined_at)
      VALUES ('${COLLECTION_ID}', 'C_ENG', 'engineering', now());
    INSERT INTO group_chat_members (collection_id, chat_user_id, display_name, real_name)
      VALUES ('${COLLECTION_ID}', 'U_ANA', 'Ana', 'Ana Ruiz');
    INSERT INTO group_chat_messages
      (collection_id, channel_id, ts, author_id, text, posted_at)
      VALUES ('${COLLECTION_ID}', 'C_ENG', '1700000000.000100', 'U_ANA',
              'chore-missandei owns the language-test rollout.', to_timestamp(1700000000));

    INSERT INTO code_files (collection_id, repo, path, sha, size, content, synced_at)
      VALUES ('${COLLECTION_ID}', 'torre/solar', '.sdkmanrc', 'sha_1', 13,
              'java=8.0.472', now());

    INSERT INTO google_drive_mirrors
      (collection_id, account_email, access_token, refresh_token, consented_at, change_page_token)
      VALUES ('${COLLECTION_ID}', 'ana@acme.test', 'sealed', 'sealed', now(), '1');
    INSERT INTO google_drive_roots (collection_id, root_id, kind, name)
      VALUES ('${COLLECTION_ID}', 'drive_eng', 'drive', 'Engineering');
    INSERT INTO google_drive_files
      (collection_id, file_id, root_id, kind, mime_type, name, parent_id, web_view_link,
       markdown, plain_text, content_hash, synced_at)
      VALUES ('${COLLECTION_ID}', 'doc_rollout', 'drive_eng', 'doc',
              'application/vnd.google-apps.document', 'Rollout plan', 'drive_eng',
              'https://docs.google.com/document/d/doc_rollout/edit', '# Owner\n\nAna leads.',
              'Owner Ana leads.', 'drive-hash', now());
  `);
});

async function documents() {
  return (
    await db.query<{
      source: string;
      external_id: string;
      title: string | null;
      locator: string | null;
    }>(
      `SELECT source, external_id, title, locator
         FROM retrieval_documents
        WHERE collection_id = $1
        ORDER BY source, external_id`,
      [COLLECTION_ID],
    )
  ).rows;
}

describe("unified retrieval source sync", () => {
  it("normalizes every current source into one idempotent ingestion path", async () => {
    const provider = new FixtureProvider();
    const first = await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: provider,
      collectionId: COLLECTION_ID,
      limit: 20,
    });

    expect(first).toEqual({
      indexed: 5,
      deleted: 0,
      exhausted: true,
      bySource: { code: 1, google_drive: 1, node: 1, notion: 1, slack: 1 },
    });
    expect(await documents()).toEqual([
      {
        source: "code",
        external_id: "torre/solar:.sdkmanrc",
        title: "torre/solar/.sdkmanrc",
        locator: "https://github.com/torre/solar/blob/HEAD/.sdkmanrc",
      },
      {
        source: "google_drive",
        external_id: "doc_rollout",
        title: "Rollout plan",
        locator: "https://docs.google.com/document/d/doc_rollout/edit",
      },
      {
        source: "node",
        external_id: "decision_source",
        title: "decision",
        locator: "https://doco.test/decision_source",
      },
      {
        source: "notion",
        external_id: "notion_page",
        title: "Language tests",
        locator: "https://notion.test/language-tests",
      },
      {
        source: "slack",
        external_id: "C_ENG:1700000000.000100",
        title: "#engineering",
        locator: "https://acme.slack.com/archives/C_ENG/p1700000000000100",
      },
    ]);
    expect(
      (
        await db.query<{ source: string; model_id: string }>(
          "SELECT DISTINCT source, model_id FROM embeddings WHERE source = 'retrieval_chunk'",
        )
      ).rows,
    ).toEqual([{ source: "retrieval_chunk", model_id: provider.modelId }]);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toHaveLength(5);
    expect(
      (
        await db.query<{ text: string }>(
          `SELECT ch.text
             FROM retrieval_chunks ch
             JOIN retrieval_documents d ON d.id = ch.document_id
            WHERE d.collection_id = $1 AND d.source = 'notion'`,
          [COLLECTION_ID],
        )
      ).rows,
    ).toEqual([{ text: "Language tests > Status" }]);
    expect(
      (
        await db.query<{ text: string }>(
          `SELECT ch.text
             FROM retrieval_chunks ch
             JOIN retrieval_documents d ON d.id = ch.document_id
            WHERE d.collection_id = $1 AND d.source = 'google_drive'`,
          [COLLECTION_ID],
        )
      ).rows.map((row) => row.text),
    ).toEqual([expect.stringContaining("Ana leads.")]);

    const second = await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: provider,
      collectionId: COLLECTION_ID,
      limit: 20,
    });
    expect(second).toEqual({
      indexed: 0,
      deleted: 0,
      exhausted: true,
      bySource: {},
    });
  });

  it("replaces changed evidence and removes evidence deleted at the source", async () => {
    const provider = new FixtureProvider();
    await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: provider,
      collectionId: COLLECTION_ID,
      limit: 20,
    });
    await db.exec(`
      UPDATE code_files SET content = 'java=17', sha = 'sha_2', synced_at = now()
       WHERE collection_id = '${COLLECTION_ID}' AND repo = 'torre/solar' AND path = '.sdkmanrc';
      DELETE FROM notion_pages
       WHERE collection_id = '${COLLECTION_ID}' AND page_id = 'notion_page';
    `);

    const result = await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: provider,
      collectionId: COLLECTION_ID,
      limit: 20,
    });

    expect(result).toEqual({
      indexed: 1,
      deleted: 1,
      exhausted: true,
      bySource: { code: 1 },
    });
    expect((await documents()).map((document) => document.source)).toEqual([
      "code",
      "google_drive",
      "node",
      "slack",
    ]);
    const codeChunk = (
      await db.query<{ text: string }>(
        `SELECT ch.text
           FROM retrieval_chunks ch
           JOIN retrieval_documents d ON d.id = ch.document_id
          WHERE d.collection_id = $1 AND d.source = 'code'`,
        [COLLECTION_ID],
      )
    ).rows[0];
    expect(codeChunk.text).toContain("java=17");
    expect(codeChunk.text).not.toContain("java=8.0.472");
  });

  it("re-embeds unchanged documents when the configured model changes", async () => {
    await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: new FixtureProvider(),
      collectionId: COLLECTION_ID,
      limit: 20,
    });
    const replacement = new FixtureProvider();
    replacement.modelId = "test:replacement-model";

    const result = await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: replacement,
      collectionId: COLLECTION_ID,
      limit: 20,
    });

    expect(result.indexed).toBe(5);
    expect(
      (
        await db.query<{ model_id: string }>(
          "SELECT DISTINCT model_id FROM embeddings WHERE source = 'retrieval_chunk'",
        )
      ).rows,
    ).toEqual([{ model_id: replacement.modelId }]);
  });

  it("indexes one hundred source documents in one provider batch by default", async () => {
    await db.exec(`
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose)
      SELECT 'decision_bulk_' || n, '${COLLECTION_ID}', 'decision', 'active',
             'Bulk retrieval source ' || n
        FROM generate_series(1, 95) AS n;
    `);
    const provider = new FixtureProvider();

    const result = await syncRetrievalSourceBatch(db as unknown as QueryClient, {
      embeddingProvider: provider,
      collectionId: COLLECTION_ID,
    });

    expect(result.indexed).toBe(100);
    expect(result.exhausted).toBe(false);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toHaveLength(100);
  });

  it("partitions a backfill into disjoint workers that cover every source", async () => {
    await db.exec(`
      INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose)
      SELECT 'decision_partition_' || n, '${COLLECTION_ID}', 'decision', 'active',
             'Partitioned retrieval source ' || n
        FROM generate_series(1, 95) AS n;
    `);
    const provider = new FixtureProvider();
    const workers = 4;
    let pruneQueries = 0;
    const countingClient: QueryClient = {
      async query<T>(sql: string, params?: unknown[]) {
        if (sql.includes("DELETE FROM retrieval_documents d")) pruneQueries += 1;
        return db.query<T>(sql, params);
      },
    };

    const results = [];
    for (let index = 0; index < workers; index++) {
      results.push(
        await syncRetrievalSourceBatch(countingClient, {
          embeddingProvider: provider,
          collectionId: COLLECTION_ID,
          partition: { index, count: workers },
        }),
      );
    }

    expect(results.reduce((total, result) => total + result.indexed, 0)).toBe(100);
    expect(results.every((result) => result.indexed > 0)).toBe(true);
    expect(await documents()).toHaveLength(100);
    expect(new Set(provider.calls.flat()).size).toBe(100);
    expect(pruneQueries).toBe(1);
  });
});
