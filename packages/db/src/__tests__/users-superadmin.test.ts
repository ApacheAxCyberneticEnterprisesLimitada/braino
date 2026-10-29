// Doco's admin pages answer one person, the host superadmin. They used to know
// that person by username, torrenegra; once people choose their usernames,
// whoever took that name would be let in, so users.superadmin marks the person
// instead. The boot that adds the column marks whoever is named torrenegra
// then, and nothing marks anyone after that.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function superadmins(): Promise<string[]> {
  const r = await db.query<{ id: string }>("SELECT id FROM users WHERE superadmin ORDER BY id");
  return r.rows.map((row) => row.id);
}

describe("the superadmin is marked once, by the username they had", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from before the column.
    await db.exec(`
      ALTER TABLE users DROP COLUMN superadmin;
      INSERT INTO users (id, username, data) VALUES
        ('user_alex', 'torrenegra', '{}'), ('user_ana', 'ana', '{}');
    `);
  });

  it("marks the person named torrenegra, and no other", async () => {
    await db.exec(schemaSql);
    expect(await superadmins()).toEqual(["user_alex"]);
  });

  it("stays with the person through a rename, and never marks whoever takes the name", async () => {
    await db.exec(schemaSql);
    await db.exec(`
      UPDATE users SET username = 'alex' WHERE id = 'user_alex';
      UPDATE users SET username = 'torrenegra' WHERE id = 'user_ana';
    `);
    await db.exec(schemaSql);
    expect(await superadmins()).toEqual(["user_alex"]);
  });
});
