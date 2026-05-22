// Forward-only schema migrations. The baseline lives in `schema.sql` and is
// applied first (idempotent — every CREATE uses IF NOT EXISTS); migrations
// in `../migrations/NNN_*.sql` then run in numerical order, with applied
// IDs recorded in the `applied_migrations` table.
//
// Rule for new schema work: stop adding DO blocks to schema.sql. Add a new
// `NNN_short_name.sql` under `packages/db/migrations/` instead. Each
// migration runs once; if it must be idempotent (e.g. picks up legacy state)
// say so in the filename + a comment at the top.
//
// scripts/embed-schema.mjs bundles every migrations/*.sql into JS strings
// in `./schema-embedded.ts`; this module reads from that array rather
// than walking the filesystem at runtime. Sidesteps Vercel's serverless
// function packaging dropping sibling .sql files.

import type { PoolClient } from "pg";
import { type EmbeddedMigration, MIGRATIONS } from "./schema-embedded.js";

export async function applyMigrations(c: PoolClient): Promise<void> {
  if (MIGRATIONS.length === 0) return;

  const applied = new Set(
    (await c.query<{ id: string }>("SELECT id FROM applied_migrations")).rows.map((r) => r.id),
  );

  for (const file of MIGRATIONS) {
    if (applied.has(file.id)) continue;
    await runOne(c, file);
  }
}

async function runOne(c: PoolClient, file: EmbeddedMigration): Promise<void> {
  await c.query("BEGIN");
  try {
    await c.query(file.sql);
    await c.query("INSERT INTO applied_migrations (id) VALUES ($1)", [file.id]);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw new Error(`Migration ${file.id} failed: ${(err as Error).message}`);
  }
}
