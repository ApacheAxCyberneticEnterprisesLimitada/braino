// A cold start applies schema.sql only when it isn't the one last applied
// (decision_01M4CH63Z7SP3XZFNE8TY811BN): re-sent on every instance's first
// query, the whole file cost every cold start its time and its exclusive
// trigger locks, and instances starting together after a deploy deadlocked.
import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applySchemaIfChanged } from "../client.js";
import { SCHEMA_SQL } from "../schema-embedded.js";
import { freshDb } from "./fresh-db.js";

/** A pg client over PGlite that counts how often it was sent schema.sql. */
function client(db: PGlite) {
  const c = {
    applied: 0,
    async query(sql: string, params?: unknown[]) {
      if (sql === SCHEMA_SQL) c.applied += 1;
      if (params) return db.query(sql, params);
      const results = await db.exec(sql);
      return results[results.length - 1] ?? { rows: [] };
    },
  };
  return c;
}

describe("applySchemaIfChanged", () => {
  it("applies schema.sql once, and again only once it changed", async () => {
    const db = await freshDb();
    const c = client(db);
    expect(await applySchemaIfChanged(c)).toBe(true);
    expect(await applySchemaIfChanged(c)).toBe(false);
    expect(c.applied).toBe(1);

    // Another deployment applied its own schema.sql since.
    await db.query("UPDATE schema_applied SET hash = 'another'");
    expect(await applySchemaIfChanged(c)).toBe(true);
    expect(c.applied).toBe(2);
  });

  it("applies it to a database it was never applied to", async () => {
    const db = await freshDb();
    await db.exec("DROP TABLE schema_applied");
    const c = client(db);
    expect(await applySchemaIfChanged(c)).toBe(true);
    expect(await applySchemaIfChanged(c)).toBe(false);
  });
});
