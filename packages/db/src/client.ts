// Postgres connection helper. Single shared pool per process.
//
// DATABASE_URL reads from env (or override via opts). Defaults to the
// Phase 2 dev container at postgres://postgres:doco@127.0.0.1:5433/doco.
//
// node:* imports + ./migrations.js live inside dynamic imports so the
// barrel that's pulled into web route bundles doesn't drag node-only
// modules into the browser graph. vite/rollup statically follow every
// top-level import; deferring these to runtime means the browser
// bundle never sees `node:fs` / `node:path` / etc.

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

async function readSchemaSql(): Promise<string> {
  if (_schemaSql) return _schemaSql;
  const { readFileSync } = await import(/* @vite-ignore */ "node:fs");
  const { dirname, join } = await import(/* @vite-ignore */ "node:path");
  const { fileURLToPath } = await import(/* @vite-ignore */ "node:url");
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
  const sql = await readSchemaSql();
  const c = await getPool().connect();
  try {
    await c.query(sql);
    // Indirect specifier so vite/rollup can't statically resolve and
    // bundle migrations.ts (which uses node:fs / node:path / etc.) into
    // browser graphs that pull from the @doco/db barrel.
    const migrationsPath = `./${"migrations"}.js`;
    const { applyMigrations } = (await import(/* @vite-ignore */ migrationsPath)) as typeof import(
      "./migrations.js"
    );
    await applyMigrations(c);
  } finally {
    c.release();
  }
}

/**
 * Apply baseline schema.sql, then any pending numbered migrations from
 * packages/db/migrations/. Idempotent — schema.sql uses IF NOT EXISTS and
 * `applied_migrations` skips migrations that already ran.
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
