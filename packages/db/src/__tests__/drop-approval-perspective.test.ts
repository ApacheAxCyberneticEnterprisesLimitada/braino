// The "Proposed" (approval) perspective was removed. schema.sql must not
// seed it into fresh databases AND must heal existing databases that still
// carry the seed row + Doco attachments — schema.sql is re-applied on every
// boot, so a self-healing DELETE is how the removal reaches production
// (mirrors the #721 CHECK-heal precedent, in reverse).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const ORG = "organization_test000000000000000";
const DOCO = "doco_test0000000000000000000000";

let db: PGlite;

describe("the Proposed (approval) perspective is gone", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql);
  });

  it("does not seed the approval perspective into a fresh database", async () => {
    const { rows } = await db.query(
      "SELECT id FROM perspectives WHERE id = 'perspective_approval' OR kind = 'approval'",
    );
    expect(rows).toEqual([]);
  });

  it("no longer allows 'approval' as a perspective kind", async () => {
    await expect(
      db.query(
        "INSERT INTO perspectives (id, slug, kind, name) VALUES ('perspective_x','x','approval','X')",
      ),
    ).rejects.toThrow();
  });

  it("heals an existing database that still has the approval perspective attached", async () => {
    // Simulate a database provisioned before the perspective was removed:
    // the kind allow-list still permits 'approval', the seed row exists, and
    // a Doco has the Proposed tab attached.
    await db.exec("ALTER TABLE perspectives DROP CONSTRAINT IF EXISTS perspectives_kind_check");
    await db.query(
      "INSERT INTO organizations (id, handle, name, data) VALUES ($1,$2,$3,'{}') ON CONFLICT DO NOTHING",
      [ORG, "org-test", "Org Test"],
    );
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, org_id, data) VALUES ($1,$2,$3,$4,'{}')",
      [DOCO, "doco-test", ORG, ORG],
    );
    await db.query(
      `INSERT INTO perspectives (id, slug, kind, name, is_builtin)
       VALUES ('perspective_approval','for-approval','approval','Proposed', true)
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
       VALUES ($1,'perspective_approval',2,false)`,
      [DOCO],
    );

    // Re-applying the baseline (what every boot/deploy does) must heal it.
    await db.exec(schemaSql);

    const perspective = await db.query(
      "SELECT 1 FROM perspectives WHERE id = 'perspective_approval'",
    );
    const attachment = await db.query(
      "SELECT 1 FROM doco_perspectives WHERE perspective_id = 'perspective_approval'",
    );
    expect(perspective.rows).toEqual([]);
    expect(attachment.rows).toEqual([]);
  });
});
