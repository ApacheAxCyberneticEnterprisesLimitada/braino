// Apply schema.sql to production's database while a deploy builds, before
// its code takes traffic (applySchemaAtDeploy in src/client.ts). @doco/web's
// build runs it last; anywhere but a Vercel production build it does
// nothing, so a preview or CI build never touches a database.

import { applySchemaAtDeploy, closePool, getPool, schemaAppliedAtDeploy } from "../dist/index.js";

if (!schemaAppliedAtDeploy()) {
  console.info("[schema] not a production deploy: schema.sql is applied on first use");
  process.exit(0);
}
// Production's processes never apply it themselves (ensureSchema), so a
// production build without its database fails rather than ship without it.
if (!process.env.DOCO_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error("[schema] no database URL in the production build: schema.sql can't be applied");
  process.exit(1);
}

const client = await getPool().connect();
try {
  const applied = await applySchemaAtDeploy(client);
  console.info(applied ? "[schema] schema.sql applied" : "[schema] schema.sql already applied");
} finally {
  client.release();
  await closePool();
}
