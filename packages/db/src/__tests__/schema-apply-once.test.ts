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

  it("reconciles an existing baseline once, then runs pending migrations", async () => {
    const db = await freshDb();
    await db.exec("DROP TABLE password_sign_in_attempts");
    await db.exec(`CREATE TABLE schema_applied (
      one boolean PRIMARY KEY DEFAULT true CHECK (one),
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const c = client(db);

    expect(await applyMigrations(c)).toEqual([
      "000_baseline",
      ...MIGRATIONS.map((migration) => migration.name),
    ]);
    expect(c.baselineApplications).toBe(1);
    expect(await applyMigrations(c)).toEqual([]);
    expect(c.statements).toContain(`SET LOCAL lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT to_regclass('public.schema_applied') IS NOT NULL AS present",
        )
      ).rows[0]?.present,
    ).toBe(false);
    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT to_regclass('public.password_sign_in_attempts') IS NOT NULL AS present",
        )
      ).rows[0]?.present,
    ).toBe(true);
    expect(
      (
        await db.query<{ table_name: string; column_name: string }>(`
          SELECT table_name, column_name
            FROM information_schema.columns
           WHERE (table_name, column_name) IN (
             ('passkeys', 'rp_id'),
             ('group_chat_channels', 'history_until'),
             ('feedback_reports', 'fixed_emailed_at')
           )
           ORDER BY table_name, column_name
        `)
      ).rows,
    ).toEqual([
      { table_name: "feedback_reports", column_name: "fixed_emailed_at" },
      { table_name: "group_chat_channels", column_name: "history_until" },
      { table_name: "passkeys", column_name: "rp_id" },
    ]);
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
