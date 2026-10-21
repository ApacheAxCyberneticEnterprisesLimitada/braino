// A silence alert's emails follow a schedule (after a week, two weeks and a
// month), and silence_alerts.email_step records the last step that went out.
// The schedule used to open with an email after a workday: on the boot that
// drops it, each alert's step moves down one, the workday's to none, so the
// alerts open then still get their week's email.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function steps(): Promise<Record<string, number>> {
  const r = await db.query<{ id: string; email_step: number }>(
    "SELECT id, email_step FROM silence_alerts ORDER BY id",
  );
  return Object.fromEntries(r.rows.map((row) => [row.id, row.email_step]));
}

describe("the email schedule opens at a week instead of a workday", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from when step 1 was the workday's email and 4 the month's.
    await db.exec(`
      ALTER TABLE silence_alerts DROP CONSTRAINT silence_alerts_email_step_check;
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'acme');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data)
        SELECT 'collection_' || n, 'acme-' || n, 'workspace_acme', 'workspace_acme', '{}'
          FROM generate_series(0, 4) AS n;
      INSERT INTO silence_alerts (id, workspace_id, collection_id, collection_ids, quiet_since, usual, email_step)
        SELECT 'alert_' || n, 'workspace_acme', 'collection_' || n, ARRAY['collection_' || n], now(), 9, n
          FROM generate_series(0, 4) AS n;
    `);
  });

  it("moves each alert's step down one, the workday's to none", async () => {
    await db.exec(schemaSql);
    expect(await steps()).toEqual({ alert_0: 0, alert_1: 0, alert_2: 1, alert_3: 2, alert_4: 3 });
  });

  it("leaves the steps that went out on every later boot", async () => {
    await db.exec(schemaSql);
    await db.exec("UPDATE silence_alerts SET email_step = 3 WHERE id = 'alert_1'");
    await db.exec(schemaSql);
    expect(await steps()).toEqual({ alert_0: 0, alert_1: 3, alert_2: 1, alert_3: 2, alert_4: 3 });
  });
});
