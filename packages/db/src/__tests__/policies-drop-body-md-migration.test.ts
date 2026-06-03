// Policies no longer carry a rationale. The `body_md` column was dropped from
// the `policies` table (the field had no template that ever populated it). The
// rule is enforced two ways: a fresh baseline never mints the column, and —
// because schema.sql is re-applied on every boot — a self-healing
// `DROP COLUMN IF EXISTS` strips it from any database provisioned under the old
// shape. This test seeds the legacy column, re-applies the baseline (what every
// boot does), and asserts it is gone.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

let db: PGlite;

async function policiesHasBodyMd(): Promise<boolean> {
  const r = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'policies' AND column_name = 'body_md'
     ) AS exists`,
  );
  return r.rows[0]?.exists ?? false;
}

describe("policies.body_md is gone (rationale field removed)", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline
  });

  it("a fresh baseline does not declare policies.body_md", async () => {
    expect(await policiesHasBodyMd()).toBe(false);
  });

  it("re-applying the baseline drops a legacy policies.body_md column", async () => {
    // Simulate a database provisioned under the old shape.
    await db.exec("ALTER TABLE policies ADD COLUMN IF NOT EXISTS body_md text");
    expect(await policiesHasBodyMd()).toBe(true);

    // Re-apply the baseline — exactly what every boot does.
    await db.exec(schemaSql);

    expect(await policiesHasBodyMd()).toBe(false);
  });
});
