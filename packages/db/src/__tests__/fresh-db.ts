import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

// The canonical baseline schema every Doco database is built from. Tests that
// stand up a *legacy* shape (to exercise a self-healing migration) build their
// own DDL instead; this is the current, full schema.
export const schemaSql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql"),
  "utf8",
);

// Booting Postgres and replaying the ~126 KB schema costs ~2.8 s; restoring a
// pre-built data dir costs ~0.7 s — ~4x faster, with every test still getting
// its own isolated database. So we pay the schema replay once per worker,
// snapshot the result, and hand each `freshDb()` a fresh restore of it.
let snapshot: Promise<Blob | File> | undefined;
function schemaSnapshot(): Promise<Blob | File> {
  if (!snapshot) {
    snapshot = (async () => {
      const seed = new PGlite({ extensions: { vector } });
      await seed.exec(schemaSql);
      const dump = await seed.dumpDataDir("none"); // uncompressed = fastest
      await seed.close();
      return dump;
    })();
  }
  return snapshot;
}

/**
 * A fresh, fully-migrated in-process Postgres — the baseline schema already
 * applied. Drop-in replacement for `new PGlite(); await db.exec(schemaSql)`.
 */
export async function freshDb(): Promise<PGlite> {
  return PGlite.create({ loadDataDir: await schemaSnapshot(), extensions: { vector } });
}
