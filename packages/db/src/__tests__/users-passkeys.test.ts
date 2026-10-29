// People sign in with their email, a password and a passkey
// (decision_01M644G5305NGN9JB7XJPRGN9H in meta-doco-product-decisions).
// users.stamp is what every session and emailed link of theirs carries
// (decision_01M644H4Y6SAKGVX7HK0TNG65R in meta-doco-security-decisions), and
// users.password_hash came back empty the day after passwords were dropped.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function users(): Promise<{ id: string; stamp: string; password_hash: string | null }[]> {
  const r = await db.query<{ id: string; stamp: string; password_hash: string | null }>(
    "SELECT id, stamp, password_hash FROM users ORDER BY id",
  );
  return r.rows;
}

describe("users' stamps and passwords", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("gives everyone in a database from before stamps a stamp of their own", async () => {
    await db.exec(`
      ALTER TABLE users DROP COLUMN stamp;
      INSERT INTO users (id, username, data) VALUES ('user_a', 'ana', '{}'), ('user_b', 'bo', '{}');
    `);
    await db.exec(schemaSql);
    const [a, b] = await users();
    expect(a?.stamp).toMatch(/.{20,}/);
    expect(a?.stamp).not.toBe(b?.stamp);
  });

  it("brings the password back empty to a database from passkeys alone, keeping every stamp", async () => {
    await db.exec(`
      ALTER TABLE users DROP COLUMN password_hash;
      INSERT INTO users (id, username, stamp, data) VALUES ('user_a', 'ana', 'stamp-a', '{}');
    `);
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    expect(await users()).toEqual([{ id: "user_a", stamp: "stamp-a", password_hash: null }]);
  });

  it("gives every new account a stamp of its own and no password", async () => {
    await db.exec(`INSERT INTO users (id, username, data) VALUES ('user_c', 'cy', '{}'),
                                                              ('user_d', 'di', '{}')`);
    const [c, d] = await users();
    expect(c?.stamp).not.toBe(d?.stamp);
    expect(c?.password_hash).toBeNull();
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

describe("authenticator apps", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`INSERT INTO users (id, username, data) VALUES ('user_a', 'ana', '{}')`);
  });

  it("are one per account, starting with no step used and no wrong codes", async () => {
    await db.query(`INSERT INTO authenticator_apps (user_id, secret) VALUES ('user_a', 'v1:x')`);
    const [app] = (
      await db.query<{ last_step: string; failures: number; last_used_at: Date | null }>(
        "SELECT last_step, failures, last_used_at FROM authenticator_apps",
      )
    ).rows;
    expect(app).toEqual({ last_step: 0, failures: 0, last_used_at: null });
    await expect(
      db.query(`INSERT INTO authenticator_apps (user_id, secret) VALUES ('user_a', 'v1:y')`),
    ).rejects.toThrow(/duplicate key/);
  });

  it("go with their person's account", async () => {
    await db.query(`INSERT INTO authenticator_apps (user_id, secret) VALUES ('user_a', 'v1:x')`);
    await db.exec("DELETE FROM users WHERE id = 'user_a'");
    expect((await db.query("SELECT 1 FROM authenticator_apps")).rows).toHaveLength(0);
  });
});
