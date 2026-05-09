import { rm, stat } from "node:fs/promises";
import type { Database } from "better-sqlite3";
import { type LoadedEvalo, loadEvalo } from "@evalo/core";
import { CACHE_DIR, cachePath, openDb } from "./db.js";
import { join } from "node:path";
import { insertEntity } from "./insert.js";

export interface BuildReport {
  inserted: number;
  durationMs: number;
}

/** Insert every entity from a freshly-loaded Evalo. Caller manages the transaction. */
export function indexEvalo(db: Database, loaded: LoadedEvalo): BuildReport {
  const start = performance.now();
  let inserted = 0;
  const tx = db.transaction(() => {
    insertEntity(db, loaded.evalo as never, "");
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
 * Wipe `.evalo/` and rebuild the index from the current source files.
 */
export async function reindex(evaloRoot: string): Promise<BuildReport> {
  await wipeCache(evaloRoot);
  const loaded = await loadEvalo(evaloRoot);
  const db = await openDb(evaloRoot);
  try {
    return indexEvalo(db, loaded);
  } finally {
    db.close();
  }
}

async function wipeCache(evaloRoot: string): Promise<void> {
  const cacheDir = join(evaloRoot, CACHE_DIR);
  try {
    await stat(cacheDir);
    await rm(cacheDir, { recursive: true, force: true });
  } catch {
    // doesn't exist; nothing to remove
  }
  // touch via openDb later
  void cachePath; // referenced for clarity
}
