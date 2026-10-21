// People sign in with an email address and a password now, not GitHub
// (decision_01M5EA9HVPXG0SF7FVZWCGXSQ1), so a person's Doco name lives in
// users.username instead of their GitHub login
// (decision_01M5EAAX2VT2MMRG0ZGKDJGMJZ). schema.sql fills it once from
// github_login, makes names and addresses unique regardless of case, and drops
// the columns only GitHub sign-in used.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function users(): Promise<{ id: string; username: string | null; email: string | null }[]> {
  const r = await db.query<{ id: string; username: string | null; email: string | null }>(
    "SELECT id, username, email FROM users ORDER BY id",
  );
  return r.rows;
}

async function columns(): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'users'`,
  );
  return r.rows.map((row) => row.column_name).sort();
}

describe("users move from GitHub logins to Doco usernames", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from GitHub sign-in: no username or password, the GitHub id,
    // an avatar nobody wrote, and the kind column production still carried.
    await db.exec(`
      DROP INDEX users_username_key;
      DROP INDEX users_email_key;
      ALTER TABLE users DROP COLUMN username, DROP COLUMN password_hash,
        ADD COLUMN github_id text, ADD COLUMN avatar_url text,
        ADD COLUMN kind text NOT NULL DEFAULT 'person';
      INSERT INTO users (id, github_id, github_login, email, data, created_at) VALUES
        ('user_a', '1', 'Ana', 'ana@example.com', '{}', '2026-01-01'),
        ('user_b', '2', 'bo', 'Same@example.com', '{}', '2026-01-02'),
        ('user_c', '3', 'BO', 'same@example.com', '{}', '2026-01-03'),
        ('user_d', NULL, NULL, '', '{}', '2026-01-04'),
        ('user_e', NULL, NULL, '', '{}', '2026-01-05');
    `);
  });

  it("names everyone after their GitHub login, numbering a second one that differs only by case", async () => {
    await db.exec(schemaSql);
    expect((await users()).map((u) => u.username)).toEqual(["Ana", "bo", "BO-2", null, null]);
  });

  it("keeps one account per address: a later account sharing one loses it, and a blank one is none", async () => {
    await db.exec(schemaSql);
    expect((await users()).map((u) => u.email)).toEqual([
      "ana@example.com",
      "Same@example.com",
      null,
      null,
      null,
    ]);
    await expect(
      db.query(
        "INSERT INTO users (id, username, email, data) VALUES ('user_x', 'x', 'ANA@example.com', '{}')",
      ),
    ).rejects.toThrow(/users_email_key/);
  });

  it("refuses a username another person has in any case", async () => {
    await db.exec(schemaSql);
    await expect(
      db.query("INSERT INTO users (id, username, data) VALUES ('user_x', 'ana', '{}')"),
    ).rejects.toThrow(/users_username_key/);
  });

  it("drops the columns only GitHub sign-in and its one-time email used, so inserts need no kind", async () => {
    await db.exec(schemaSql);
    expect(await columns()).toEqual(
      [
        "created_at",
        "data",
        "deactivated_at",
        "email",
        "github_login",
        "id",
        "password_hash",
        "updated_at",
        "username",
      ].sort(),
    );
  });

  it("fills usernames once: a later account's stays as it was made", async () => {
    await db.exec(schemaSql);
    await db.exec(
      `INSERT INTO users (id, github_login, username, data) VALUES ('user_f', 'Fe', 'fe-1', '{}')`,
    );
    await db.exec(schemaSql);
    const f = (await users()).find((u) => u.id === "user_f");
    expect(f?.username).toBe("fe-1");
  });
});
