// A feedback report keeps the build it was sent from as client_context.app
// .release. Reports sent while the header read "Alpha <sha>" kept the words
// they scraped from it as app.alpha_text; once the header named the private
// beta instead (Alexander, 2026-11-04: "Alpha => Private beta"), schema.sql
// carried those over, so a report names its build one way.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function apps(): Promise<Record<string, unknown>> {
  const r = await db.query<{ id: string; app: unknown }>(
    "SELECT id, client_context->'app' AS app FROM feedback_reports ORDER BY id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.app]));
}

describe("feedback_reports' release", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`
      INSERT INTO feedback_reports (id, report_type, client_context) VALUES
        ('feedback_a', 'bug', '{"title": "A", "app": {"alpha_text": "Alpha 8f0df10"}}'),
        ('feedback_b', 'idea', '{"app": {"alpha_text": null}}'),
        ('feedback_c', 'bug', '{"app": {"release": "736c98c"}}'),
        ('feedback_d', 'bug', '{}');
    `);
  });

  it("names each older report's build as its release", async () => {
    await db.exec(schemaSql);
    expect(await apps()).toEqual({
      feedback_a: { release: "8f0df10" },
      feedback_b: {},
      feedback_c: { release: "736c98c" },
      feedback_d: null,
    });
    const title = await db.query<{ title: string }>(
      "SELECT client_context->>'title' AS title FROM feedback_reports WHERE id = 'feedback_a'",
    );
    expect(title.rows[0]?.title).toBe("A");
  });

  it("leaves them as they are on every later boot", async () => {
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    expect((await apps()).feedback_a).toEqual({ release: "8f0df10" });
  });
});
