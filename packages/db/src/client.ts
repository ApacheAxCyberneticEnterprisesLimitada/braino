// Postgres connection helper. Single shared pool per process.
//
// DATABASE_URL reads from env (or override via opts). Defaults to the
// Phase 2 dev container at postgres://postgres:doco@127.0.0.1:5433/doco.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _schemaReady: Promise<void> | null = null;
let _schemaSql: string | null = null;

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

function readSchemaSql(): string {
  if (_schemaSql) return _schemaSql;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "schema.sql"),
    join(here, "..", "src", "schema.sql"),
  ];
  for (const c of candidates) {
    try {
      _schemaSql = readFileSync(c, "utf8");
      return _schemaSql;
    } catch {}
  }
  throw new Error("Could not locate schema.sql alongside @doco/db build.");
}

async function applySchema(): Promise<void> {
  const sql = readSchemaSql();
  const c = await getPool().connect();
  try {
    await c.query(sql);
  } finally {
    c.release();
  }
}

/**
 * Apply schema.sql to the connected database. Idempotent — every CREATE
 * uses IF NOT EXISTS, so it's safe to call on every startup.
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

export async function pingDb(): Promise<{ ok: true; version: string }> {
  const r = await withClient(async (c) => c.query("SELECT version() AS v"));
  return { ok: true, version: String(r.rows[0]?.v ?? "") };
}

/**
 * v15: short-circuit guard for SQL paths that still read from the
 * legacy `scopes` table. Returns true when the table exists, false
 * after the v15 DROP lands. Cached per process; first call probes
 * the catalog, subsequent calls hit the cache.
 *
 * Use it like:
 *   if (!(await scopesTableExists())) return [];
 *   // …then run the legacy SELECT FROM scopes …
 */
let _scopesTableExists: boolean | null = null;
export async function scopesTableExists(): Promise<boolean> {
  if (_scopesTableExists !== null) return _scopesTableExists;
  const r = await withClient((c) =>
    c.query<{ exists: boolean }>(
      "SELECT to_regclass('public.scopes') IS NOT NULL AS exists",
    ),
  );
  _scopesTableExists = !!r.rows[0]?.exists;
  return _scopesTableExists;
}
