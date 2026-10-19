// A silence alert's emails follow a schedule (after a workday, a week, two
// weeks and a month), and silence_alerts.email_step records the last step
// that went out. It replaced emailed_at and emails, from when an alert was
// emailed up to three times a day apart: on the boot that adds it, an alert
// already emailed has had its first step, and one not yet emailed none.
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

describe("the email step replaces when and how often an alert was emailed", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from before the column.
    await db.exec(`
      ALTER TABLE silence_alerts DROP COLUMN email_step, DROP COLUMN reading;
      ALTER TABLE silence_alerts ADD COLUMN emailed_at timestamptz,
                                 ADD COLUMN emails int NOT NULL DEFAULT 0;
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'acme');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES
        ('collection_a', 'acme-a', 'workspace_acme', 'workspace_acme', '{}'),
        ('collection_b', 'acme-b', 'workspace_acme', 'workspace_acme', '{}'),
        ('collection_c', 'acme-c', 'workspace_acme', 'workspace_acme', '{}');
      INSERT INTO silence_alerts
          (id, workspace_id, collection_id, collection_ids, quiet_since, usual, emailed_at, emails)
        VALUES
          ('alert_new', 'workspace_acme', 'collection_a', '{collection_a}', now(), 9, NULL, 0),
          ('alert_once', 'workspace_acme', 'collection_b', '{collection_b}', now(), 9, now(), 1),
          ('alert_thrice', 'workspace_acme', 'collection_c', '{collection_c}', now(), 9, now(), 3);
    `);
  });

  it("counts an alert already emailed as past its first step", async () => {
    await db.exec(schemaSql);
    expect(await steps()).toEqual({ alert_new: 0, alert_once: 1, alert_thrice: 1 });
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'silence_alerts' AND column_name IN ('emailed_at', 'emails', 'reading')`,
    );
    expect(rows).toEqual([{ column_name: "reading" }]);
  });

  it("leaves the steps that went out on every later boot", async () => {
    await db.exec(schemaSql);
    await db.exec("UPDATE silence_alerts SET email_step = 3 WHERE id = 'alert_once'");
    await db.exec(schemaSql);
    expect(await steps()).toEqual({ alert_new: 0, alert_once: 3, alert_thrice: 1 });
  });
});
