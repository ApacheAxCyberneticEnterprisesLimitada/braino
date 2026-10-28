// Apply schema.sql to production's database while a deploy builds, before
// its code takes traffic (applySchemaAtDeploy in src/client.ts). @doco/web's
// build runs it last; anywhere but a Vercel production build it does
// nothing, so a preview or CI build never touches a database.

import { applySchemaAtDeploy, closePool, getPool } from "../dist/index.js";

if (process.env.VERCEL_ENV !== "production") {
  console.info("[schema] not a production deploy: schema.sql is applied on first use");
  process.exit(0);
}
if (!process.env.DOCO_DATABASE_URL && !process.env.DATABASE_URL) {
  console.warn(
    "[schema] WARNING: no database URL in the build: schema.sql is applied on first use",
  );
  process.exit(0);
}

const client = await getPool().connect();
try {
  const applied = await applySchemaAtDeploy(client);
  console.info(applied ? "[schema] schema.sql applied" : "[schema] schema.sql already applied");
} finally {
  client.release();
  await closePool();
}
