import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import type { GlobalSetupContext } from "vitest/node";
import { schemaSql } from "./schema-sql.js";

// Vitest globalSetup: build the fully-migrated database once per test run and
// hand its data dir to every worker, so `freshDb()` only ever restores it.
// Creating a cluster and replaying the schema costs ~2.5 s, and each test file
// used to pay it again (test files don't share module state).
export default async function setup({ provide }: GlobalSetupContext) {
  // 1 MB WAL segments instead of 16 MB: a smaller data dir restores faster.
  const seed = new PGlite({ extensions: { vector }, initDbStartParams: ["--wal-segsize=1"] });
  await seed.exec(schemaSql);
  const dump = await seed.dumpDataDir("none"); // uncompressed = fastest restore
  await seed.close();

  const dir = await mkdtemp(join(tmpdir(), "doco-schema-"));
  const file = join(dir, "schema.tar");
  await writeFile(file, Buffer.from(await dump.arrayBuffer()));
  provide("docoSchemaSnapshot", file);
  return () => rm(dir, { recursive: true, force: true });
}
