import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

describe("recommend-survey migration", () => {
  it("upgrades an existing database to the hosted survey contract", async () => {
    const db = await freshDb();
    await db.exec("DROP TABLE IF EXISTS nps_surveys");
    await db.exec("ALTER TABLE users DROP COLUMN IF EXISTS nps_emails");

    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "004_nps_surveys.sql"),
      "utf8",
    );
    await db.exec(migration);

    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT to_regclass('public.nps_surveys') IS NOT NULL AS present",
        )
      ).rows[0]?.present,
    ).toBe(true);
    expect(
      (
        await db.query<{ data_type: string }>(
          `SELECT data_type FROM information_schema.columns
            WHERE table_name = 'users' AND column_name = 'nps_emails'`,
        )
      ).rows,
    ).toEqual([{ data_type: "boolean" }]);
  });
});
