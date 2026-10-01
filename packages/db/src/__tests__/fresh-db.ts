import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { inject, onTestFinished } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    docoSchemaSnapshot: string;
  }
}

// schema-snapshot.global-setup.ts builds the migrated database once per run;
// every vitest config that runs real-DB tests lists it in `globalSetup`.
let snapshot: Promise<Blob> | undefined;
function schemaSnapshot(): Promise<Blob> {
  if (!snapshot) {
    snapshot = readFile(inject("docoSchemaSnapshot")).then((bytes) => new Blob([bytes]));
  }
  return snapshot;
}

/**
 * A fresh, fully-migrated in-process Postgres: the baseline schema already
 * applied, restored from the run's snapshot (~0.5 s instead of ~2.5 s to
 * create a cluster and replay the schema).
 *
 * Opened inside a test or its `beforeEach`, it closes when the test finishes:
 * each open PGlite holds its WASM memory, and a file's leftover instances made
 * every later restore ~3x slower. Opened in `beforeAll`, it lives for the file.
 */
export async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create({ loadDataDir: await schemaSnapshot(), extensions: { vector } });
  try {
    onTestFinished(() => db.close());
  } catch {
    // Not inside a test (a `beforeAll`): the file shares this database.
  }
  return db;
}
