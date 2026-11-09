#!/usr/bin/env node

import { closePool, migrateDatabase } from "./client.js";

try {
  const applied = await migrateDatabase();
  console.info(
    applied.length > 0
      ? `[migrations] applied ${applied.join(", ")}`
      : "[migrations] database is current",
  );
} finally {
  await closePool();
}
