import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { migrate } from "./migrate.js";

export const CACHE_DIR = ".evalo";
export const CACHE_FILE = "cache.db";

export function cachePath(evaloRoot: string): string {
  return join(evaloRoot, CACHE_DIR, CACHE_FILE);
}

export interface OpenDbOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

export async function openDb(evaloRoot: string, opts: OpenDbOptions = {}): Promise<DB> {
  const path = cachePath(evaloRoot);
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
