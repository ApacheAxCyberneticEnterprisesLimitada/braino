// Postgres connection helper. Single shared pool per process.
//
// DATABASE_URL reads from env (or override via opts). Defaults to the
// Phase 2 dev container at postgres://postgres:doco@127.0.0.1:5433/doco.
//
// The fresh baseline and ordered forward migrations are embedded into the
// server build, so a released image always carries the exact SQL it expects.

import pg from "pg";
import { BASELINE_SQL, MIGRATIONS } from "./schema-embedded.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _schemaReady: Promise<void> | null = null;

function pem(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\n/g, "\n");
  return normalized || undefined;
}

export function databasePoolConfig(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const connectionString =
    env.DOCO_DATABASE_URL ?? env.DATABASE_URL ?? "postgres://postgres:doco@127.0.0.1:5433/doco";
  const configuredMax = env.DOCO_DATABASE_POOL_MAX?.trim();
  const max = configuredMax ? Number(configuredMax) : 10;
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error("DOCO_DATABASE_POOL_MAX must be between 1 and 100");
  }

  const ca = pem(env.DOCO_DATABASE_CA);
  const cert = pem(env.DOCO_DATABASE_CERT);
  const key = pem(env.DOCO_DATABASE_KEY);
  if (Boolean(cert) !== Boolean(key)) {
    throw new Error("DOCO_DATABASE_CERT and DOCO_DATABASE_KEY must be configured together");
  }
  if ((cert || key) && !ca) {
    throw new Error("DOCO_DATABASE_CA is required with TLS client credentials");
  }

  return {
    connectionString,
    max,
    ...(ca
      ? {
          ssl: {
            ca,
            ...(cert && key ? { cert, key } : {}),
            rejectUnauthorized: true,
          },
        }
      : {}),
  };
}

export function getPool(): pg.Pool {
  if (_pool) return _pool;
  _pool = new Pool(databasePoolConfig());
  _pool.on("error", (err) => {
    console.error("@doco/db pool error:", err);
  });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (!_pool) return;
  await _pool.end();
  _pool = null;
  _schemaReady = null;
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

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export const MIGRATION_LOCK_TIMEOUT_MS = 2_000;
const BUSY = new Set(["55P03", "40P01"]);

async function appliedMigrations(c: QueryClient): Promise<AppliedMigration[]> {
  const present = await c.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (!present.rows[0]?.present) return [];
  return (
    await c.query<AppliedMigration>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
  ).rows;
}

function verifyAppliedMigrations(rows: AppliedMigration[]): void {
  const expected = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
  for (const row of rows) {
    const migration = expected.get(row.version);
    if (!migration) {
      throw new Error(
        `Database migration ${row.version} (${row.name}) is newer than this Braino image.`,
      );
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(
        `Database migration ${row.version} (${migration.name}) checksum does not match the released migration.`,
      );
    }
  }
}

/** Apply every pending migration atomically before the application serves traffic. */
export async function applyMigrations(c: QueryClient): Promise<string[]> {
  const appliedNames: string[] = [];
  await c.query("BEGIN");
  try {
    await c.query(`SET LOCAL lock_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    await c.query("SELECT pg_advisory_xact_lock(hashtext('doco_schema_migrations'))");
    await c.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version integer PRIMARY KEY CHECK (version >= 0),
         name text NOT NULL UNIQUE,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const existing = await c.query<{ present: boolean }>(
      "SELECT to_regclass('public.workspaces') IS NOT NULL AS present",
    );
    const fresh = !existing.rows[0]?.present;
    if (fresh) {
      await c.query(BASELINE_SQL);
      appliedNames.push("000_baseline");
      for (const migration of MIGRATIONS) {
        await c.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
      }
    }

    const rows = await appliedMigrations(c);
    if (rows.length === 0) {
      await c.query("DROP TABLE IF EXISTS schema_applied");
    }

    verifyAppliedMigrations(rows);
    const appliedVersions = new Set(rows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      await c.query(migration.sql);
      await c.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        migration.version,
        migration.name,
        migration.checksum,
      ]);
      appliedNames.push(migration.name);
    }
    await c.query("COMMIT");
    return appliedNames;
  } catch (error) {
    try {
      await c.query("ROLLBACK");
    } catch {
      // Preserve the migration failure when the connection itself also failed.
    }
    throw error;
  }
}

/** Fail closed when application code is newer or older than the database. */
export async function assertMigrationsCurrent(c: QueryClient): Promise<void> {
  const rows = await appliedMigrations(c);
  verifyAppliedMigrations(rows);
  if (
    rows.length !== MIGRATIONS.length ||
    MIGRATIONS.some((migration, index) => rows[index]?.version !== migration.version)
  ) {
    throw new Error("Braino database migrations are pending; run the migration command first.");
  }
}

/** Run the controlled startup/upgrade migration with bounded lock retries. */
export async function migrateDatabase({
  attempts = 60,
  waitMs = 5_000,
}: { attempts?: number; waitMs?: number } = {}): Promise<string[]> {
  const client = await getPool().connect();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await applyMigrations(client);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!code || !BUSY.has(code) || attempt >= attempts) throw error;
        console.info(`[migrations] database busy (${code}); retrying ${attempt}/${attempts}`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  } finally {
    client.release();
  }
}

/** Validate the database once per process; schema changes happen only at startup. */
export async function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const client = await getPool().connect();
      try {
        await assertMigrationsCurrent(client);
      } finally {
        client.release();
      }
    })().catch((error) => {
      _schemaReady = null;
      throw error;
    });
  }
  await _schemaReady;
}
