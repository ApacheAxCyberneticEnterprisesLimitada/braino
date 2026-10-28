// Postgres connection helper. Single shared pool per process.
//
// DATABASE_URL reads from env (or override via opts). Defaults to the
// Phase 2 dev container at postgres://postgres:doco@127.0.0.1:5433/doco.
//
// schema.sql is bundled into a JS string by scripts/embed-schema.mjs
// (regenerated at build time into src/schema-embedded.ts). This
// sidesteps Vercel's serverless function packaging dropping sibling
// .sql files and avoids static node:fs imports that vite/rollup would
// drag into browser graphs.

import { createHash } from "node:crypto";
import pg from "pg";
import { SCHEMA_SQL } from "./schema-embedded.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _schemaReady: Promise<void> | null = null;

export function getPool(): pg.Pool {
  if (_pool) return _pool;
  const url =
    process.env.DOCO_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://postgres:doco@127.0.0.1:5433/doco";
  _pool = new Pool({ connectionString: url, max: 10 });
  _pool.on("error", (err) => {
    console.error("@doco/db pool error:", err);
  });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (!_pool) return;
  await _pool.end();
  _pool = null;
}

export async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const c = await getPool().connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

/** schema.sql's fingerprint, recorded in schema_applied once it is applied. */
const SCHEMA_HASH = createHash("sha256").update(SCHEMA_SQL).digest("hex");

/** How long schema.sql waits for any one lock before it gives up. Its DROP and
 *  CREATE TRIGGERs lock the busiest tables, and every query on a table queues
 *  behind a lock request that waits: a short wait keeps live traffic moving,
 *  and the deploy tries again (applySchemaAtDeploy). */
export const SCHEMA_LOCK_TIMEOUT_MS = 2_000;

/**
 * Apply schema.sql unless it is the one last applied, and say whether it was
 * (decision_01M4CH63Z7SP3XZFNE8TY811BN): a cold start costs one read instead of
 * the whole file, its table scans and its DROP/CREATE TRIGGERs, which lock the
 * busiest tables. Instances starting together after a deploy take turns, since
 * applying it side by side deadlocks. A lock it can't get within
 * SCHEMA_LOCK_TIMEOUT_MS fails the whole file, which applies in one
 * transaction, so nothing is left half done.
 */
export async function applySchemaIfChanged(c: QueryClient): Promise<boolean> {
  if ((await appliedSchemaHash(c)) === SCHEMA_HASH) return false;
  await c.query("SELECT pg_advisory_lock(hashtext('doco_schema'))");
  try {
    if ((await appliedSchemaHash(c)) === SCHEMA_HASH) return false;
    await c.query(`SET lock_timeout = ${SCHEMA_LOCK_TIMEOUT_MS}`);
    try {
      await c.query(SCHEMA_SQL);
    } finally {
      await c.query("RESET lock_timeout");
    }
    await c.query(
      `INSERT INTO schema_applied (hash) VALUES ($1)
       ON CONFLICT (one) DO UPDATE SET hash = EXCLUDED.hash, applied_at = now()`,
      [SCHEMA_HASH],
    );
    return true;
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('doco_schema'))");
  }
}

/** Postgres's codes for a lock not had in time, and for a deadlock. */
const BUSY = new Set(["55P03", "40P01"]);

/**
 * Apply schema.sql while a deploy builds, before its code takes traffic, so
 * no request ever waits on it: production's build runs this
 * (scripts/apply-schema.mjs), and a cold start then finds it applied. While
 * the old deployment's traffic holds the tables it tries again, and fails
 * the build, which leaves the old deployment serving, if they stay busy.
 */
export async function applySchemaAtDeploy(
  c: QueryClient,
  { attempts = 60, waitMs = 5_000 }: { attempts?: number; waitMs?: number } = {},
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await applySchemaIfChanged(c);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (!code || !BUSY.has(code) || attempt >= attempts) throw err;
      console.info(`[schema] tables busy (${code}), trying again (${attempt}/${attempts})`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function appliedSchemaHash(c: QueryClient): Promise<string | null> {
  try {
    const { rows } = await c.query<{ hash: string }>("SELECT hash FROM schema_applied");
    return rows[0]?.hash ?? null;
  } catch (err) {
    // A database schema.sql was never applied to.
    if ((err as { code?: string }).code === "42P01") return null;
    throw err;
  }
}

async function applySchema(): Promise<void> {
  const c = await getPool().connect();
  try {
    await applySchemaIfChanged(c);
  } finally {
    c.release();
  }
}

/** Bring the database to schema.sql once per process (applySchemaIfChanged). */
export async function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = applySchema().catch((err) => {
      _schemaReady = null;
      throw err;
    });
  }
  await _schemaReady;
}
