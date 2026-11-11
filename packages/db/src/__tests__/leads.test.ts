import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

const insert = "INSERT INTO leads (id, kind, email, status) VALUES ($1, $2, $3, $4)";

describe("leads", () => {
  it("upgrades an existing database to the hosted leads contract", async () => {
    const db = await freshDb();
    await db.exec("DROP TABLE IF EXISTS leads");

    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "005_leads.sql"),
      "utf8",
    );
    await db.exec(migration);

    expect(
      (
        await db.query<{ present: boolean }>(
          "SELECT to_regclass('public.leads') IS NOT NULL AS present",
        )
      ).rows[0]?.present,
    ).toBe(true);
  });

  it("keeps one row per form and address", async () => {
    const db = await freshDb();
    await db.query(insert, ["lead_1", "partner", "a@x.co", "applied"]);
    await db.query(insert, ["lead_2", "open_source", "a@x.co", "waiting"]);
    await expect(db.query(insert, ["lead_3", "partner", "a@x.co", "applied"])).rejects.toThrow();
  });

  it("takes only the statuses of the lead's own form", async () => {
    const db = await freshDb();
    await db.query(insert, ["lead_1", "managed_services", "a@x.co", "contacted"]);
    await expect(
      db.query(insert, ["lead_2", "open_source", "b@x.co", "contacted"]),
    ).rejects.toThrow();
    await expect(db.query(insert, ["lead_3", "job_seeker", "c@x.co", "new"])).rejects.toThrow();
  });
});
