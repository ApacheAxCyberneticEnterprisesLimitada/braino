// The lifecycle vocabulary migration constrains policy tables to two stages
// (`active`/`retired`) with a CHECK. Because that CHECK validates every
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
    "INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,'{}') ON CONFLICT DO NOTHING",
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
    // stages: drop the CHECKs, then insert policy rows the old capture path
    // allowed — a `drafting` guidance policy and a `proposed` authoring policy.
    await db.exec(
      "ALTER TABLE guidance_policies DROP CONSTRAINT IF EXISTS guidance_policies_lifecycle_check",
    );
    await db.exec(
      "ALTER TABLE node_authoring_policies DROP CONSTRAINT IF EXISTS node_authoring_policies_lifecycle_check",
    );
    await db.query(
      "INSERT INTO guidance_policies (id, doco_id, policy, lifecycle, data) VALUES ($1,$2,$3,$4,'{}')",
      ["guidance_policy_legacy00000000", DOCO, "legacy drafting policy", "drafting"],
    );
    await db.query(
      "INSERT INTO node_authoring_policies (id, doco_id, policy, lifecycle, data) VALUES ($1,$2,$3,$4,'{}')",
      ["node_authoring_policy_legacy00", DOCO, "legacy proposed policy", "proposed"],
    );

    // Re-applying schema.sql is what every boot/deploy does — it MUST NOT throw
    // on the out-of-range rows.
    await db.exec(schemaSql);

    // Both legacy rows are normalized to `active`.
    const g = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM guidance_policies WHERE id = 'guidance_policy_legacy00000000'",
    );
    const n = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM node_authoring_policies WHERE id = 'node_authoring_policy_legacy00'",
    );
    expect(g.rows[0]?.lifecycle).toBe("active");
    expect(n.rows[0]?.lifecycle).toBe("active");

    // ...and the two-stage CHECK is back in force for new writes.
    await expect(
      db.query(
        "INSERT INTO guidance_policies (id, doco_id, policy, lifecycle, data) VALUES ('guidance_policy_bad0000000000',$1,'x','drafting','{}')",
        [DOCO],
      ),
    ).rejects.toThrow();
  });
});
