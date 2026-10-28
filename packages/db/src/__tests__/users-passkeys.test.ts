// People sign in with passkeys, not passwords (decision_01M623N7EK5E1FCMPEY495V7NW
// in meta-doco-product-decisions). users.stamp is what every session and
// emailed link of theirs carries; schema.sql fills it once from the stamp the
// password era sealed into sessions (the SHA-256 of the account's id and
// password hash), so whoever was signed in stays signed in to add a passkey,
// and then drops the password hash.
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

/** The stamp a password-era session cookie carries. */
function passwordEraStamp(id: string, passwordHash: string | null): string {
  return createHash("sha256")
    .update(`${id}:${passwordHash ?? ""}`)
    .digest("base64url")
    .slice(0, 22);
}

async function stamps(): Promise<Record<string, string>> {
  const r = await db.query<{ id: string; stamp: string }>(
    "SELECT id, stamp FROM users ORDER BY id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.stamp]));
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}

describe("users move from passwords to passkeys", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from the password era: a password hash, no stamp.
    await db.exec(`
      ALTER TABLE users DROP COLUMN stamp, ADD COLUMN password_hash text;
      INSERT INTO users (id, username, email, password_hash, data) VALUES
        ('user_a', 'ana', 'ana@example.com', 'scrypt$c2FsdA$a2V5', '{}'),
        ('user_b', 'bo', 'bo@example.com', NULL, '{}');
    `);
  });

  it("keeps every session signed in: each stamp is the one its cookies carry", async () => {
    await db.exec(schemaSql);
    expect(await stamps()).toEqual({
      user_a: passwordEraStamp("user_a", "scrypt$c2FsdA$a2V5"),
      user_b: passwordEraStamp("user_b", null),
    });
  });

  it("drops the password hash", async () => {
    await db.exec(schemaSql);
    expect(await hasColumn("users", "password_hash")).toBe(false);
  });

  it("fills stamps once: a second boot changes none", async () => {
    await db.exec(schemaSql);
    const first = await stamps();
    await db.exec(schemaSql);
    expect(await stamps()).toEqual(first);
  });

  it("gives every new account a stamp of its own", async () => {
    await db.exec(schemaSql);
    await db.exec(`INSERT INTO users (id, username, data) VALUES ('user_c', 'cy', '{}'),
                                                              ('user_d', 'di', '{}')`);
    const { user_c, user_d } = await stamps();
    expect(user_c).toMatch(/.{20,}/);
    expect(user_c).not.toBe(user_d);
  });
});

describe("passkeys", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`INSERT INTO users (id, username, data) VALUES ('user_a', 'ana', '{}')`);
  });

  it("go with their person's account", async () => {
    await db.query(
      `INSERT INTO passkeys (id, user_id, public_key, aaguid)
       VALUES ('cred-1', 'user_a', '\\x01'::bytea, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd')`,
    );
    await db.exec("DELETE FROM users WHERE id = 'user_a'");
    expect((await db.query("SELECT 1 FROM passkeys")).rows).toHaveLength(0);
  });
});
