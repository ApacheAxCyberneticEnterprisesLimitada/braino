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

async function applySchema(): Promise<void> {
  const c = await getPool().connect();
  try {
    await c.query(SCHEMA_SQL);
  } finally {
    c.release();
  }
}

/**
 * Apply baseline schema.sql. Idempotent — schema.sql uses IF NOT EXISTS.
 */
export async function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = applySchema().catch((err) => {
      _schemaReady = null;
      throw err;
    });
  }
  await _schemaReady;
}
