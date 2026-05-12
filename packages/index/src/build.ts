import { rm, stat } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import { type LoadedDoco, loadDoco } from "@doco/core";
import { CACHE_DIR, cachePath, openDb } from "./db.js";
import { join } from "node:path";
import { insertEntity } from "./insert.js";

export interface BuildReport {
  inserted: number;
  durationMs: number;
}

/** Insert every entity from a freshly-loaded Doco. Caller manages the transaction. */
export function indexDoco(db: Database, loaded: LoadedDoco): BuildReport {
  const start = performance.now();
  let inserted = 0;
  const tx = db.transaction(() => {
    insertEntity(db, loaded.doco as never, "");
    inserted++;
    for (const le of loaded.entities.values()) {
      insertEntity(db, le.entity, le.parsed.body);
      inserted++;
    }
  });
  tx();
  const durationMs = Math.round(performance.now() - start);
  return { inserted, durationMs };
}

/**
 * Wipe `.doco/` and rebuild the index from the current source files.
 */
export async function reindex(docoRoot: string): Promise<BuildReport> {
  await wipeCache(docoRoot);
  const loaded = await loadDoco(docoRoot);
  const db = await openDb(docoRoot);
  try {
    return indexDoco(db, loaded);
  } finally {
    db.close();
  }
}

async function wipeCache(docoRoot: string): Promise<void> {
  const cacheDir = join(docoRoot, CACHE_DIR);
  try {
    await stat(cacheDir);
    await rm(cacheDir, { recursive: true, force: true });
  } catch {
    // doesn't exist; nothing to remove
  }
  // touch via openDb later
  void cachePath; // referenced for clarity
}
