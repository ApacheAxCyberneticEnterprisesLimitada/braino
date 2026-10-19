// Alexander, 2026-10-13: "Invite your colleagues" is a workspace owner's last
// setup step, after their own agent starts using Doco, and it is done only
// once they end or skip it. It used to read as done once any agent worked in
// the workspace, so schema.sql ends it for every owner it read as done for
// when the step moved, which shipped on 2026-10-17: an owner who joined before
// then, of a workspace agents had worked in by then. A workspace already set
// up never shows its steps again, and only members and work from before the
// move match, so a reboot changes nothing.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

const BEFORE = "2026-10-12T09:00:00Z";
const AFTER = "2026-10-17T13:00:00Z";

/** Each onboarding row: how the person joined, and whether they ended inviting. */
async function rows(): Promise<Record<string, { joined_as: string; invite: string | null }>> {
  const r = await db.query<{
    workspace_id: string;
    user_id: string;
    joined_as: string;
    invite: string | null;
  }>(
    `SELECT workspace_id, user_id, joined_as, invite_done_at::text AS invite
       FROM workspace_onboarding ORDER BY workspace_id, user_id`,
  );
  return Object.fromEntries(
    r.rows.map((row) => [
      `${row.workspace_id}/${row.user_id}`,
      { joined_as: row.joined_as, invite: row.invite },
    ]),
  );
}

describe("ending the invite step for owners it read as done for", () => {
  beforeEach(async () => {
    db = await freshDb();
    await db.exec(`
      INSERT INTO users (id, github_login, data) VALUES
        ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}'), ('user_cy', 'cy', '{}'),
        ('user_dee', 'dee', '{}'), ('user_eve', 'eve', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES
        ('workspace_acme', 'acme', 'acme'), ('workspace_quiet', 'quiet', 'quiet');
      INSERT INTO workspace_users (workspace_id, user_id, role, joined_at) VALUES
        ('workspace_acme', 'user_ana', 'owner', '${BEFORE}'),
        ('workspace_acme', 'user_bo', 'writer', '${BEFORE}'),
        ('workspace_acme', 'user_cy', 'owner', '${BEFORE}'),
        ('workspace_acme', 'user_dee', 'owner', '${AFTER}'),
        ('workspace_quiet', 'user_eve', 'owner', '${BEFORE}');
      INSERT INTO workspace_onboarding (workspace_id, user_id, joined_as, started_at) VALUES
        ('workspace_acme', 'user_cy', 'invitee', '${BEFORE}');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES
        ('collection_acme', 'acme-decisions', 'workspace_acme', 'workspace_acme', '{}'),
        ('collection_quiet', 'quiet-decisions', 'workspace_quiet', 'workspace_quiet', '{}');
      -- An agent wrote in acme before the step moved; quiet's only after.
      INSERT INTO changesets (collection_id, actor, source, metadata, recorded_at) VALUES
        ('collection_acme', 'user_bo', 'mcp', '{"surface": "mcp"}', '${BEFORE}'),
        ('collection_quiet', 'user_eve', 'mcp', '{"surface": "mcp"}', '${AFTER}');
    `);
  });

  it("ends it for the owners who joined a workspace agents worked in before the move", async () => {
    await db.exec(schemaSql);
    const after = await rows();
    expect(Object.keys(after)).toEqual(["workspace_acme/user_ana", "workspace_acme/user_cy"]);
    expect(after["workspace_acme/user_ana"]).toMatchObject({ joined_as: "creator" });
    expect(after["workspace_acme/user_ana"].invite).not.toBeNull();
    // Invited as an owner: still an invitee, now past inviting too.
    expect(after["workspace_acme/user_cy"]).toMatchObject({ joined_as: "invitee" });
    expect(after["workspace_acme/user_cy"].invite).not.toBeNull();
  });

  it("counts an agent's reads too", async () => {
    await db.exec(`
      INSERT INTO query_events (workspace_id, actor, source, metadata, at)
        VALUES ('workspace_quiet', 'user_eve', 'api', '{"auth": "oauth"}', '${BEFORE}');
    `);
    await db.exec(schemaSql);
    expect(Object.keys(await rows())).toContain("workspace_quiet/user_eve");
  });

  it("never sends a reminder for the rows it adds", async () => {
    await db.exec(schemaSql);
    const { rows: added } = await db.query<{ reminded: boolean }>(
      `SELECT reminded_at IS NOT NULL AS reminded FROM workspace_onboarding
        WHERE user_id = 'user_ana'`,
    );
    expect(added).toEqual([{ reminded: true }]);
  });

  it("changes nothing on a later boot", async () => {
    await db.exec(schemaSql);
    const first = await rows();
    await db.exec(`
      INSERT INTO workspace_users (workspace_id, user_id, role, joined_at)
        VALUES ('workspace_quiet', 'user_dee', 'owner', '${AFTER}');
      INSERT INTO changesets (collection_id, actor, source, metadata, recorded_at)
        VALUES ('collection_quiet', 'user_dee', 'mcp', '{"surface": "mcp"}', '${AFTER}');
    `);
    await db.exec(schemaSql);
    expect(await rows()).toEqual(first);
  });
});
