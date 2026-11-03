import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

describe("retrieval source documents", () => {
  it("tracks source edits rather than unchanged connector refreshes", async () => {
    const db = await freshDb();
    await db.exec(`
      INSERT INTO workspaces (id, handle, name)
        VALUES ('workspace_sources', 'sources', 'Sources');
      INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data)
        VALUES ('collection_sources', 'sources-documents', 'workspace_sources',
                'workspace_sources', 'private', '{}'::jsonb);

      INSERT INTO notion_mirrors
        (collection_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
        VALUES ('collection_sources', 'notion_workspace', 'Sources', 'notion_bot',
                'sealed', now());
      INSERT INTO notion_pages
        (collection_id, page_id, object, title, url, markdown, last_edited_time, synced_at)
        VALUES ('collection_sources', 'notion_page', 'page', 'Product plan',
                'https://notion.test/product-plan', '# Product plan',
                '2026-10-01T12:00:00Z', '2026-11-01T12:00:00Z');

      INSERT INTO google_drive_mirrors
        (collection_id, domain, admin_email, consented_at)
        VALUES ('collection_sources', 'sources.test', 'admin@sources.test', now());
      INSERT INTO google_drive_roots (collection_id, root_id, kind, name, reads_as)
        VALUES ('collection_sources', 'drive_root', 'drive', 'Sources', 'admin@sources.test');
      INSERT INTO google_drive_files
        (collection_id, file_id, root_id, kind, mime_type, name, markdown,
         modified_time, synced_at)
        VALUES ('collection_sources', 'drive_file', 'drive_root', 'doc',
                'application/vnd.google-apps.document', 'Architecture', '# Architecture',
                '2026-10-02T12:00:00Z', '2026-11-02T12:00:00Z');
    `);

    async function sourceTimes() {
      return (
        await db.query<{ source: string; source_updated_at: Date }>(`
          SELECT source, source_updated_at
            FROM retrieval_source_documents
           WHERE collection_id = 'collection_sources'
           ORDER BY source
        `)
      ).rows.map((row) => ({
        source: row.source,
        source_updated_at: row.source_updated_at.toISOString(),
      }));
    }

    expect(await sourceTimes()).toEqual([
      { source: "google_drive", source_updated_at: "2026-10-02T12:00:00.000Z" },
      { source: "notion", source_updated_at: "2026-10-01T12:00:00.000Z" },
    ]);

    await db.exec(`
      UPDATE notion_pages SET synced_at = '2026-11-03T12:00:00Z'
       WHERE collection_id = 'collection_sources';
      UPDATE google_drive_files SET synced_at = '2026-11-03T12:00:00Z'
       WHERE collection_id = 'collection_sources';
    `);

    expect(await sourceTimes()).toEqual([
      { source: "google_drive", source_updated_at: "2026-10-02T12:00:00.000Z" },
      { source: "notion", source_updated_at: "2026-10-01T12:00:00.000Z" },
    ]);
  });
});
