// A database still holding the per-person Drive mirror (one person's OAuth
// grant, its refresh_token) drops it for the company's, and makes the views
// that read its files again.
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

describe("replacing the per-person Google Drive mirror", () => {
  it("drops the old tables even though views read google_drive_files", async () => {
    const db = await freshDb();
    await db.exec("ALTER TABLE google_drive_mirrors ADD COLUMN refresh_token text");
    await db.exec(schemaSql);
    const old = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'google_drive_mirrors' AND column_name = 'refresh_token'`,
    );
    expect(old.rows).toEqual([]);
    const views = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.views
        WHERE table_name IN ('imported_items', 'retrieval_source_documents') ORDER BY 1`,
    );
    expect(views.rows.map((v) => v.table_name)).toEqual([
      "imported_items",
      "retrieval_source_documents",
    ]);
  });
});
