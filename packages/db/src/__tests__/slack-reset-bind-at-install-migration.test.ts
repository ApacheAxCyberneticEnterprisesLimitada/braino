// Slack teams now bind to a Doco workspace at install time. The deploy that
// introduces that flow resets ALL prior Slack state once (installs, channel
// defaults, personal links) so every team re-installs through it. The reset is
// gated on a schema_oneshots marker (not idempotent in place — it deletes), so
// it runs exactly once. This test removes the marker to mimic a pre-migration
// DB, re-applies the baseline, and asserts the one-time wipe + that later state
// survives.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

let db: PGlite;

async function counts(): Promise<{ installs: number; channels: number; links: number }> {
  const q = async (t: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE provider = 'slack'`))
      .rows[0].n;
  return {
    installs: await q("group_chat_installations"),
    channels: await q("group_chat_channel_connections"),
    links: await q("group_chat_user_links"),
  };
}

async function seedSlackState(team: string) {
  await db.query(
    "INSERT INTO group_chat_installations (id, provider, workspace_id) VALUES ($1,'slack',$2)",
    [`gci_${team}`, team],
  );
  await db.query(
    `INSERT INTO group_chat_channel_connections
       (id, provider, workspace_id, channel_id, target_level, target_id, role)
     VALUES ($1,'slack',$2,'*','workspace','workspace_x','reader')`,
    [`gcc_${team}`, team],
  );
  await db.query(
    "INSERT INTO group_chat_user_links (id, provider, workspace_id, chat_user_id, user_id) VALUES ($1,'slack',$2,'U1','user_alice')",
    [`gcul_${team}`, team],
  );
}

describe("slack reset-on-bind-at-install migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(schemaSql); // fresh baseline records the marker
    await db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
    // Mimic a pre-migration DB: drop the one-shot marker, then seed Slack state.
    await db.query("DELETE FROM schema_oneshots WHERE name = 'slack_reset_bind_at_install'");
    await seedSlackState("T_OLD");
  });

  it("wipes all Slack state exactly once, then leaves new state alone", async () => {
    expect(await counts()).toEqual({ installs: 1, channels: 1, links: 1 });

    await db.exec(schemaSql); // the migration boot
    expect(await counts()).toEqual({ installs: 0, channels: 0, links: 0 });
    const marker = await db.query(
      "SELECT 1 FROM schema_oneshots WHERE name = 'slack_reset_bind_at_install'",
    );
    expect(marker.rows).toHaveLength(1);

    // A team that re-installs after the reset survives later boots.
    await seedSlackState("T_NEW");
    await db.exec(schemaSql);
    expect(await counts()).toEqual({ installs: 1, channels: 1, links: 1 });
  });
});
