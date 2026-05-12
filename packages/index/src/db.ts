import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { migrate } from "./migrate.js";

export const CACHE_DIR = ".doco";
export const CACHE_FILE = "cache.db";

export function cachePath(docoRoot: string): string {
  return join(docoRoot, CACHE_DIR, CACHE_FILE);
}

export interface OpenDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export async function openDb(docoRoot: string, opts: OpenDbOptions = {}): Promise<DB> {
  const path = cachePath(docoRoot);
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false,
  });
  if (!opts.readonly) {
    migrate(db);
  }
  return db;
}

export function closeDb(db: DB): void {
  db.close();
}
