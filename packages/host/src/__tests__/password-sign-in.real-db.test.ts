import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  clearPasswordSignInAttempts,
  reservePasswordSignInAttempt,
  revokeUserSessions,
} from "../password-sign-in.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

describe("password sign-in throttling", () => {
  it("blocks an account bucket before another password hash is attempted", async () => {
    const bucket = { scope: "account", identifier: "owner@example.com", maxAttempts: 3 };
    await expect(reservePasswordSignInAttempt(client(), [bucket])).resolves.toMatchObject({
      allowed: true,
    });
    await expect(reservePasswordSignInAttempt(client(), [bucket])).resolves.toMatchObject({
      allowed: true,
    });
    await expect(reservePasswordSignInAttempt(client(), [bucket])).resolves.toMatchObject({
      allowed: true,
    });
    await expect(reservePasswordSignInAttempt(client(), [bucket])).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("clears account and client buckets after a valid sign-in", async () => {
    const buckets = [
      { scope: "account", identifier: "owner@example.com", maxAttempts: 1 },
      { scope: "client", identifier: "203.0.113.4", maxAttempts: 1 },
    ];
    await expect(reservePasswordSignInAttempt(client(), buckets)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(reservePasswordSignInAttempt(client(), buckets)).resolves.toMatchObject({
      allowed: false,
    });
    await clearPasswordSignInAttempts(client(), buckets);
    await expect(reservePasswordSignInAttempt(client(), buckets)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("rotates the stamp that every live browser session must carry", async () => {
    const inserted = await db.query<{ stamp: string }>(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ('user_owner', 'owner', 'Owner', 'owner@example.com', 'hash', '{}'::jsonb)
       RETURNING stamp`,
    );
    await revokeUserSessions(client(), "user_owner");
    const current = await db.query<{ stamp: string }>(
      "SELECT stamp FROM users WHERE id = 'user_owner'",
    );
    expect(current.rows[0]?.stamp).not.toBe(inserted.rows[0]?.stamp);
  });
});
