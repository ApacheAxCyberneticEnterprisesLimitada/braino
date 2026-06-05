// The lifecycle vocabulary migration constrains the policies table to two
// stages (`active`/`retired`) with a CHECK. Because that CHECK validates every
// existing row, a database that predates it can carry a policy row in some
// other stage (the old capture path validated against {drafting, asserted,
// retired}). The migration must NORMALIZE any such out-of-range policy row to
// `active` before adding the CHECK — otherwise ADD CONSTRAINT throws and
// schema apply (run on every boot/deploy) fails. This test simulates that
// legacy state and asserts re-applying schema.sql heals it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const ORG = "workspace_test000000000000000";
const DOCO = "doco_test0000000000000000000000";

let db: PGlite;

async function seedDoco(): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [ORG, "workspace-test", "Workspace Test"],
  );
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}')",
    [DOCO, "doco-test", ORG, ORG],
  );
}

describe("lifecycle migration heals legacy policy rows", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql);
    await seedDoco();
  });

  it("normalizes any non-{active,retired} policy lifecycle to active and restores the CHECK", async () => {
    // Simulate a database provisioned before policies were constrained to two
    // stages: drop the CHECK, then insert policy rows the old capture path
    // allowed — a `drafting` row and a `proposed` row.
    await db.exec("ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_lifecycle_check");
    await db.query("INSERT INTO policies (id, doco_id, lifecycle, data) VALUES ($1,$2,$3,'{}')", [
      "policy_legacy_drafting0000000",
      DOCO,
      "drafting",
    ]);
    await db.query("INSERT INTO policies (id, doco_id, lifecycle, data) VALUES ($1,$2,$3,'{}')", [
      "policy_legacy_proposed000000",
      DOCO,
      "proposed",
    ]);

    // Re-applying schema.sql is what every boot/deploy does — it MUST NOT throw
    // on the out-of-range rows.
    await db.exec(schemaSql);

    // Both legacy rows are normalized to `active`.
    const drafting = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM policies WHERE id = 'policy_legacy_drafting0000000'",
    );
    const proposed = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM policies WHERE id = 'policy_legacy_proposed000000'",
    );
    expect(drafting.rows[0]?.lifecycle).toBe("active");
    expect(proposed.rows[0]?.lifecycle).toBe("active");

    // ...and the two-stage CHECK is back in force for new writes.
    await expect(
      db.query(
        "INSERT INTO policies (id, doco_id, lifecycle, data) VALUES ('policy_bad00000000000000000',$1,'drafting','{}')",
        [DOCO],
      ),
    ).rejects.toThrow();
  });
});
