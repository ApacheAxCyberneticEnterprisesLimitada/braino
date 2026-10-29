// A cold start applies schema.sql only when it isn't the one last applied
// (decision_01M4CH63Z7SP3XZFNE8TY811BN): re-sent on every instance's first
// query, the whole file cost every cold start its time and its exclusive
// trigger locks, and instances starting together after a deploy deadlocked.
import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_LOCK_TIMEOUT_MS,
  applySchemaAtDeploy,
  applySchemaIfChanged,
  ensureSchema,
  schemaAppliedAtDeploy,
} from "../client.js";
import { SCHEMA_SQL } from "../schema-embedded.js";
import { freshDb } from "./fresh-db.js";

/** A pg client over PGlite that counts how often it was sent schema.sql. */
function client(db: PGlite) {
  const c = {
    applied: 0,
    statements: [] as string[],
    async query(sql: string, params?: unknown[]) {
      c.statements.push(sql);
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

  it("holds the schema lock inside a transaction", async () => {
    const db = await freshDb();
    const c = client(db);

    expect(await applySchemaIfChanged(c)).toBe(true);

    const begin = c.statements.indexOf("BEGIN");
    const lock = c.statements.indexOf("SELECT pg_advisory_xact_lock(hashtext('doco_schema'))");
    const schema = c.statements.indexOf(SCHEMA_SQL);
    const commit = c.statements.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(schema).toBeGreaterThan(lock);
    expect(commit).toBeGreaterThan(schema);
  });

  it("applies it to a database it was never applied to", async () => {
    const db = await freshDb();
    await db.exec("DROP TABLE schema_applied");
    const c = client(db);
    expect(await applySchemaIfChanged(c)).toBe(true);
    expect(await applySchemaIfChanged(c)).toBe(false);
  });
});

/** A client that refuses schema.sql's locks the first `busy` times, as Postgres
 *  does when lock_timeout runs out behind live traffic. */
function busyClient(db: PGlite, busy: number) {
  const c = client(db);
  const sent: string[] = [];
  let refusals = busy;
  return Object.assign(c, {
    sent,
    async query(sql: string, params?: unknown[]) {
      sent.push(sql === SCHEMA_SQL ? "schema.sql" : sql);
      if (sql === SCHEMA_SQL && refusals-- > 0) {
        throw Object.assign(new Error("canceling statement due to lock timeout"), {
          code: "55P03",
        });
      }
      return client(db).query(sql, params);
    },
  });
}

describe("schema.sql behind live traffic", () => {
  it("waits for each lock only briefly, so traffic is never queued behind it for long", async () => {
    const db = await freshDb();
    await db.query("UPDATE schema_applied SET hash = 'another'");
    const c = busyClient(db, 0);
    await applySchemaIfChanged(c);
    const at = c.sent.indexOf("schema.sql");
    expect(c.sent[at - 1]).toBe(`SET LOCAL lock_timeout = ${SCHEMA_LOCK_TIMEOUT_MS}`);
  });

  it("is applied at deploy, trying again while the tables are busy", async () => {
    const db = await freshDb();
    await db.query("UPDATE schema_applied SET hash = 'another'");
    const c = busyClient(db, 2);
    expect(await applySchemaAtDeploy(c, { attempts: 3, waitMs: 0 })).toBe(true);
    expect(c.sent.filter((sql) => sql === "schema.sql")).toHaveLength(3);
    expect(await applySchemaIfChanged(client(db))).toBe(false);
  });

  it("fails the deploy when the tables stay busy", async () => {
    const db = await freshDb();
    await db.query("UPDATE schema_applied SET hash = 'another'");
    await expect(
      applySchemaAtDeploy(busyClient(db, 5), { attempts: 3, waitMs: 0 }),
    ).rejects.toThrow("lock timeout");
  });
});

describe("a running process in production", () => {
  // Vercel keeps serving a tab opened before a deploy from the deployment it
  // was opened on. That deployment found the new deploy's schema.sql applied,
  // took it for one to apply its own older file over, and deadlocked against
  // live traffic, so every sign-in from such a tab failed (2026-10-29).
  it("leaves schema.sql to the deploy, so an older deployment never applies its own", async () => {
    expect(schemaAppliedAtDeploy({ VERCEL_ENV: "production" })).toBe(true);
    expect(schemaAppliedAtDeploy({ VERCEL_ENV: "preview" })).toBe(false);
    expect(schemaAppliedAtDeploy({})).toBe(false);
    // No database answers here, so applying it would fail.
    await expect(ensureSchema({ VERCEL_ENV: "production" })).resolves.toBeUndefined();
  });
});
