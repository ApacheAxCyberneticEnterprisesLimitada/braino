// schema.sql re-applies top-to-bottom on every boot (applySchema). A CREATE
// INDEX that references a column added by a tail migration must NOT appear
// BEFORE that migration: on a pre-existing table the inline CREATE TABLE is a
// no-op, so the column isn't there yet and the index errors — aborting the
// WHOLE schema-apply and 500ing every DB-backed request on cold start. This is
// the regression guard for `docos.deleted_at` (#1151 shipped the index ahead of
// the ADD COLUMN heal): re-applying schema.sql against a table that predates the
// column must SUCCEED and restore both the column and its index.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, schemaSql } from "./fresh-db.js";

let db: PGlite;

async function has(query: string): Promise<boolean> {
  const r = await db.query(query);
  return r.rows.length === 1;
}

describe("schema.sql heals a docos table that predates deleted_at", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("re-applying schema.sql does not error on the deleted_at index ordering", async () => {
    // Simulate the production shape: docos created before deleted_at shipped.
    await db.exec(
      "DROP INDEX IF EXISTS docos_deleted_at_idx; ALTER TABLE docos DROP COLUMN deleted_at;",
    );
    expect(
      await has(
        "SELECT 1 FROM information_schema.columns WHERE table_name='docos' AND column_name='deleted_at'",
      ),
    ).toBe(false);

    // Boot-time convergence must NOT throw (the index must not run before the
    // ADD COLUMN that heals the column).
    await db.exec(schemaSql);

    expect(
      await has(
        "SELECT 1 FROM information_schema.columns WHERE table_name='docos' AND column_name='deleted_at'",
      ),
    ).toBe(true);
    expect(await has("SELECT 1 FROM pg_indexes WHERE indexname = 'docos_deleted_at_idx'")).toBe(
      true,
    );
  });
});
