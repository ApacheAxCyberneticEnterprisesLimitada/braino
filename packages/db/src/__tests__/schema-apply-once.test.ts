import type { PGlite } from "@electric-sql/pglite";
import { PGlite as Database } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { describe, expect, it } from "vitest";
import { MIGRATION_LOCK_TIMEOUT_MS, applyMigrations, assertMigrationsCurrent } from "../client.js";
import { BASELINE_SQL, MIGRATIONS } from "../schema-embedded.js";
import { freshDb } from "./fresh-db.js";

function client(db: PGlite) {
  const state = { baselineApplications: 0, statements: [] as string[] };
  return Object.assign(state, {
    async query(sql: string, params?: unknown[]) {
      state.statements.push(sql);
      if (sql === BASELINE_SQL) state.baselineApplications += 1;
      if (params) return db.query(sql, params);
      const results = await db.exec(sql);
      return results[results.length - 1] ?? { rows: [] };
    },
  });
}

describe("versioned database migrations", () => {
  it("applies the baseline and every forward migration once on a fresh database", async () => {
    const db = new Database({ extensions: { vector } });
    try {
      const c = client(db);
      expect(await applyMigrations(c)).toEqual(["000_baseline"]);
      expect(c.baselineApplications).toBe(1);
      expect(
        (
          await db.query<{ version: number }>(
            "SELECT version FROM schema_migrations ORDER BY version",
          )
        ).rows,
      ).toEqual(MIGRATIONS.map((migration) => ({ version: migration.version })));
      expect(
        (
          await db.query<{ present: boolean }>(
            "SELECT to_regclass('public.schema_applied') IS NOT NULL AS present",
          )
        ).rows[0]?.present,
      ).toBe(false);
      await expect(assertMigrationsCurrent(c)).resolves.toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("adopts an existing baseline without replaying it, then runs only pending migrations", async () => {
    const db = await freshDb();
    await db.exec(`CREATE TABLE schema_applied (
      one boolean PRIMARY KEY DEFAULT true CHECK (one),
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const c = client(db);

    expect(await applyMigrations(c)).toEqual(MIGRATIONS.map((migration) => migration.name));
    expect(c.baselineApplications).toBe(0);
    expect(await applyMigrations(c)).toEqual([]);
    expect(c.statements).toContain(`SET LOCAL lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT to_regclass('public.schema_applied') IS NOT NULL AS present",
        )
      ).rows[0]?.present,
    ).toBe(false);
  });

  it("refuses an edited migration after its checksum was recorded", async () => {
    const db = await freshDb();
    const c = client(db);
    await applyMigrations(c);
    await db.query("UPDATE schema_migrations SET checksum = 'edited' WHERE version = 1");

    await expect(applyMigrations(c)).rejects.toThrow("checksum");
  });

  it("does not let the application serve against pending migrations", async () => {
    const db = await freshDb();
    const c = client(db);

    await expect(assertMigrationsCurrent(c)).rejects.toThrow("database migrations are pending");
  });
});
