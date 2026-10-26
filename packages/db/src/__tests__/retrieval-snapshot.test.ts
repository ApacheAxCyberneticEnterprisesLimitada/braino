import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { embeddingLiteral, rankEmbeddings } from "../embeddings.js";
import {
  exportRetrievalSnapshot,
  restoreRetrievalSnapshot,
  retrievalSnapshotDigest,
} from "../retrieval-snapshot.js";
import { freshDb } from "./fresh-db.js";

const COLLECTION_ID = "collection_snapshot";

async function seedSource(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name, constitution)
      VALUES ('workspace_snapshot', 'snapshot-workspace', 'Snapshot workspace', 'Be exact.');
    INSERT INTO collections
      (id, handle, owner_id, workspace_id, visibility, goal, data, created_at, updated_at)
      VALUES (
        '${COLLECTION_ID}', 'snapshot-collection', 'workspace_snapshot', 'workspace_snapshot',
        'private', 'Test retrieval parity.',
        '{"github_integration":{"connections":[{"repo":"acme/solar","installation_token":"never-copy"}]},"api_key":"never-copy"}'::jsonb,
        '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
      );
    INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, locator, extra)
      VALUES
        ('decision_jdk', '${COLLECTION_ID}', 'decision', 'active', 'Solar uses JDK 8.', 'acme/solar/.sdkmanrc', '{"answer":"8"}'::jsonb),
        ('reference_solar', '${COLLECTION_ID}', 'reference', 'active', 'Solar build file.', 'acme/solar/build.yml', '{}'::jsonb);
    INSERT INTO edges
      (id, collection_id, edge_type, from_id, from_node_type, to_id, to_node_type)
      VALUES ('edge_jdk', '${COLLECTION_ID}', 'supports', 'reference_solar', 'reference', 'decision_jdk', 'decision');
    INSERT INTO node_ranks (node_id, rank) VALUES ('decision_jdk', 1.75);
    INSERT INTO entity_fts_nodes (entity_id, collection_id, node_type, summary, body)
      VALUES ('decision_jdk', '${COLLECTION_ID}', 'decision', 'Solar JDK', 'Solar uses JDK 8.');

    INSERT INTO group_chat_installations
      (id, provider, workspace_id, workspace_name, bot_access_token, data, doco_workspace_id)
      VALUES ('installation_snapshot', 'slack', 'T-SNAPSHOT', 'Acme Slack', 'slack-secret',
              '{"signing_secret":"never-copy"}'::jsonb, 'workspace_snapshot');
    INSERT INTO group_chat_mirrors
      (collection_id, installation_id, team_domain, history_since, consented_at, created_at)
      VALUES ('${COLLECTION_ID}', 'installation_snapshot', 'acme', '2025-01-01T00:00:00Z',
              '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
    INSERT INTO group_chat_channels (collection_id, channel_id, name, topic, joined_at)
      VALUES ('${COLLECTION_ID}', 'C-SOLAR', 'solar', 'Solar service', '2025-01-01T00:00:00Z');
    INSERT INTO group_chat_members (collection_id, chat_user_id, display_name, real_name)
      VALUES ('${COLLECTION_ID}', 'U-ENGINEER', 'Engineer', 'An Engineer');
    INSERT INTO group_chat_messages
      (collection_id, channel_id, ts, author_id, text, posted_at, embedded_hash)
      VALUES ('${COLLECTION_ID}', 'C-SOLAR', '1700000000.000100', 'U-ENGINEER',
              'Solar still runs JDK 8.', '2025-02-01T00:00:00Z', md5('Solar still runs JDK 8.'));

    INSERT INTO notion_mirrors
      (collection_id, workspace_id, workspace_name, bot_id, access_token, refresh_token,
       authorized_by, consented_at, created_at)
      VALUES ('${COLLECTION_ID}', 'notion-workspace', 'Acme Notion', 'notion-bot', 'notion-secret',
              'notion-refresh-secret', 'Owner', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z');
    INSERT INTO notion_pages
      (collection_id, page_id, object, title, url, plain_text, markdown, content_hash,
       fetch_pending, synced_at, embedded_hash)
      VALUES ('${COLLECTION_ID}', 'page-jdk', 'page', 'Solar runtime',
              'https://notion.so/page-jdk', 'The production runtime is JDK 8.',
              'The production runtime is **JDK 8**.', 'notion-hash', false,
              '2025-02-01T00:00:00Z', 'notion-hash');
    INSERT INTO notion_users (collection_id, user_id, name)
      VALUES ('${COLLECTION_ID}', 'notion-user', 'Editor');
    INSERT INTO notion_links (collection_id, from_page_id, to_page_id)
      VALUES ('${COLLECTION_ID}', 'page-jdk', 'page-related');

    INSERT INTO code_files (collection_id, repo, path, sha, size, content, synced_at)
      VALUES ('${COLLECTION_ID}', 'acme/solar', '.sdkmanrc', 'sha-jdk', 13,
              'java=8.0.472', '2025-02-01T00:00:00Z');
  `);
  await db.query(
    `INSERT INTO embeddings
       (collection_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding,
        updated_at)
     VALUES
       ($1, 'node', 'decision_jdk', 0, 'text-embedding-3-small', 'node-hash',
        'Solar uses JDK 8.', $2::real[], '2025-02-01T00:00:00Z'),
       ($1, 'slack', 'C-SOLAR:1700000000.000100', 0, 'text-embedding-3-small',
        'slack-hash', 'Solar still runs JDK 8.', $2::real[], '2025-02-01T00:00:00Z'),
       ($1, 'notion', 'page-jdk', 0, 'text-embedding-3-small', 'notion-hash',
        'The production runtime is JDK 8.', $2::real[], '2025-02-01T00:00:00Z')`,
    [COLLECTION_ID, embeddingLiteral([1, 0, 0])],
  );
}

async function retrievalSignature(db: PGlite): Promise<Record<string, unknown>> {
  const [graph, slack, notion, code, semantic, ranks] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT entity_id AS id FROM entity_fts_nodes
        WHERE collection_id = $1 AND search_tsv @@ websearch_to_tsquery('english', 'Solar JDK')
        ORDER BY ts_rank_cd(search_tsv, websearch_to_tsquery('english', 'Solar JDK')) DESC,
                 entity_id`,
      [COLLECTION_ID],
    ),
    db.query<{ id: string }>(
      `SELECT channel_id || ':' || ts AS id FROM group_chat_messages
        WHERE collection_id = $1 AND search_tsv @@ websearch_to_tsquery('simple', 'Solar JDK')
        ORDER BY posted_at DESC, channel_id, ts`,
      [COLLECTION_ID],
    ),
    db.query<{ id: string }>(
      `SELECT page_id AS id FROM notion_pages
        WHERE collection_id = $1 AND search_tsv @@ websearch_to_tsquery('simple', 'production JDK')
        ORDER BY last_edited_time DESC NULLS LAST, page_id`,
      [COLLECTION_ID],
    ),
    db.query<{ id: string }>(
      `SELECT repo || ':' || path AS id FROM code_files
        WHERE collection_id = $1 AND search_tsv @@ websearch_to_tsquery('simple', 'java')
        ORDER BY repo, path`,
      [COLLECTION_ID],
    ),
    rankEmbeddings(db, {
      collectionIds: [COLLECTION_ID],
      source: "node",
      modelId: "text-embedding-3-small",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    }).then((hits) => ({ rows: hits.map((hit) => ({ id: hit.entity_id })) })),
    db.query<{ id: string; rank: number }>(
      `SELECT r.node_id AS id, r.rank FROM node_ranks r
        JOIN nodes n ON n.id = r.node_id
       WHERE n.collection_id = $1 ORDER BY r.rank DESC, r.node_id`,
      [COLLECTION_ID],
    ),
  ]);
  return {
    graph: graph.rows,
    slack: slack.rows,
    notion: notion.rows,
    code: code.rows,
    semantic: semantic.rows,
    ranks: ranks.rows,
  };
}

describe("retrieval corpus snapshots", () => {
  it("restores the same ranked corpus without copying connector credentials", async () => {
    const source = await freshDb();
    const target = await freshDb();
    await seedSource(source);
    const sourceRetrieval = await retrievalSignature(source);

    const snapshot = await exportRetrievalSnapshot(source, COLLECTION_ID, {
      appRevision: "revision-under-test",
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("never-copy");
    expect(serialized).not.toContain("slack-secret");
    expect(serialized).not.toContain("notion-secret");
    expect(serialized).not.toContain("notion-refresh-secret");
    expect(snapshot.manifest.appRevision).toBe("revision-under-test");
    expect(snapshot.manifest.modelIds).toEqual(["text-embedding-3-small"]);

    const restored = await restoreRetrievalSnapshot(target, snapshot);
    expect(restored.digest).toBe(snapshot.manifest.digest);
    expect(await retrievalSignature(target)).toEqual(sourceRetrieval);

    const roundTrip = await exportRetrievalSnapshot(target, COLLECTION_ID, {
      appRevision: "revision-under-test",
      exportedAt: snapshot.manifest.exportedAt,
    });
    expect(retrievalSnapshotDigest(roundTrip)).toBe(retrievalSnapshotDigest(snapshot));
    expect(roundTrip.tables).toEqual(snapshot.tables);

    await expect(restoreRetrievalSnapshot(target, snapshot)).rejects.toThrow(
      /already contains collection collection_snapshot/,
    );
  });
});
