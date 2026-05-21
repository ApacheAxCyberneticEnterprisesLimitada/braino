// Forward-only schema migrations. The baseline lives in `schema.sql` and is
// applied first (idempotent — every CREATE uses IF NOT EXISTS); migrations
// in `../migrations/NNN_*.sql` then run in numerical order, with applied
// IDs recorded in the `applied_migrations` table.
//
// Rule for new schema work: stop adding DO blocks to schema.sql. Add a new
// `NNN_short_name.sql` under `packages/db/migrations/` instead. Each
// migration runs once; if it must be idempotent (e.g. picks up legacy state)
// say so in the filename + a comment at the top.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";

const MIGRATIONS_DIRNAME = "migrations";
const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/i;

interface MigrationFile {
  id: string;
  path: string;
}

function locateMigrationsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", MIGRATIONS_DIRNAME),
    join(here, "..", "..", MIGRATIONS_DIRNAME),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {}
  }
  return null;
}

function listMigrationFiles(): MigrationFile[] {
  const dir = locateMigrationsDir();
  if (!dir) return [];
  const entries = readdirSync(dir).filter((name) => FILE_PATTERN.test(name));
  entries.sort();
  return entries.map((name) => ({ id: name.replace(/\.sql$/i, ""), path: join(dir, name) }));
}

export async function applyMigrations(c: PoolClient): Promise<void> {
  const files = listMigrationFiles();
  if (files.length === 0) return;

  const applied = new Set(
    (await c.query<{ id: string }>("SELECT id FROM applied_migrations")).rows.map((r) => r.id),
  );

  for (const file of files) {
    if (applied.has(file.id)) continue;
    const sql = readFileSync(file.path, "utf8");
    await c.query("BEGIN");
    try {
      await c.query(sql);
      await c.query("INSERT INTO applied_migrations (id) VALUES ($1)", [file.id]);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw new Error(`Migration ${file.id} failed: ${(err as Error).message}`);
    }
  }
}
