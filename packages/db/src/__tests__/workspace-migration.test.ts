// The "organization" container was renamed to "workspace". schema.sql is
// re-applied on every boot, so a self-healing migration is how the rename —
// table, columns, and the organization_<ulid> id prefix — reaches a database
// provisioned under the old names. This test stands up a legacy-shaped
// database, re-applies the baseline (what every boot does), and asserts the
// in-place migration. The org-CHART perspective (perspective_org_tree) is a
// different concept and must survive untouched.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

// A database as the pre-rename schema would have built it: `organizations`,
// `org_users`, org_id FKs, granted_org_* grant columns, target_level='org'.
const LEGACY_SCHEMA = `
CREATE TABLE users (id text PRIMARY KEY, github_login text, data jsonb NOT NULL DEFAULT '{}');
CREATE TABLE organizations (
  id text PRIMARY KEY, handle text NOT NULL UNIQUE, name text NOT NULL,
  constitution text NOT NULL DEFAULT '', data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE org_users (
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL, write_types text[] NOT NULL DEFAULT ARRAY[]::text[],
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE docos (
  id text PRIMARY KEY, handle text NOT NULL UNIQUE, owner_id text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE audit_events (
  event_id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), by_user text,
  doco_id text, org_id text REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL, entity_id text NOT NULL, op text NOT NULL
);
CREATE TABLE oauth_access_tokens (
  token text PRIMARY KEY, user_id text, expires_at timestamptz NOT NULL DEFAULT now(),
  granted_org_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  granted_org_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_org_write_types jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE tokens_blob (key text PRIMARY KEY, blob jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE group_chat_channel_connections (
  id text PRIMARY KEY, provider text NOT NULL DEFAULT 'slack',
  workspace_id text NOT NULL DEFAULT 'T_SLACK', channel_id text NOT NULL DEFAULT 'C1',
  channel_name text NOT NULL DEFAULT '',
  target_level text NOT NULL CHECK (target_level IN ('org','doco')),
  target_id text NOT NULL, role text NOT NULL DEFAULT 'owner',
  UNIQUE (provider, workspace_id, channel_id, target_level, target_id)
);
`;

const OLD_ID = "organization_01TESTWORKSPACEAAAAAAAAAA";
const NEW_ID = "workspace_01TESTWORKSPACEAAAAAAAAAA";

let db: PGlite;

describe("organization -> workspace migration", () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(LEGACY_SCHEMA);
    await db.query("INSERT INTO users (id) VALUES ('user_1')");
    await db.query(
      "INSERT INTO organizations (id, handle, name, constitution) VALUES ($1,'acme','Acme',$2)",
      [OLD_ID, "Follow the policies of every Doco in this organization. They are binding."],
    );
    await db.query("INSERT INTO org_users (org_id, user_id, role) VALUES ($1,'user_1','owner')", [
      OLD_ID,
    ]);
    await db.query(
      "INSERT INTO docos (id, handle, owner_id, org_id) VALUES ('doco_1','store',$1,$1)",
      [OLD_ID],
    );
    await db.query(
      "INSERT INTO audit_events (event_id, org_id, entity_type, entity_id, op) VALUES ('ae_1',$1,'workspace',$1,'entity.create')",
      [OLD_ID],
    );
    await db.query(
      "INSERT INTO oauth_access_tokens (token, granted_org_ids, granted_org_roles) VALUES ('tok_1', ARRAY[$1::text], jsonb_build_object($1::text,'reader'))",
      [OLD_ID],
    );
    await db.query(
      "INSERT INTO tokens_blob (key, blob) VALUES ('invite_1', jsonb_build_object('org_id',$1::text))",
      [OLD_ID],
    );
    // Use a non-slack provider: the org->workspace rewrite applies to every
    // provider, and this keeps the row out of the one-time slack-reset heal
    // (which deletes provider='slack' group-chat rows on the same boot).
    await db.query(
      "INSERT INTO group_chat_channel_connections (id, provider, target_level, target_id) VALUES ('gcc_1','other','org',$1)",
      [OLD_ID],
    );

    // Re-applying the baseline (what every boot/deploy does) migrates it.
    await db.exec(schemaSql);
  });

  it("renames organizations -> workspaces and rewrites the id prefix", async () => {
    const ws = await db.query<{ id: string; handle: string }>("SELECT id, handle FROM workspaces");
    expect(ws.rows).toEqual([{ id: NEW_ID, handle: "acme" }]);
    const gone = await db.query<{ t: string | null }>(
      "SELECT to_regclass('public.organizations') AS t",
    );
    expect(gone.rows[0].t).toBeNull();
  });

  it("renames org_users -> workspace_users with a workspace_id column", async () => {
    const { rows } = await db.query("SELECT workspace_id, user_id FROM workspace_users");
    expect(rows).toEqual([{ workspace_id: NEW_ID, user_id: "user_1" }]);
  });

  it("rewrites docos.workspace_id and owner_id", async () => {
    const { rows } = await db.query("SELECT workspace_id, owner_id FROM docos WHERE id='doco_1'");
    expect(rows[0]).toEqual({ workspace_id: NEW_ID, owner_id: NEW_ID });
  });

  it("rewrites audit_events workspace_id and the organization entity_id", async () => {
    const { rows } = await db.query(
      "SELECT workspace_id, entity_id FROM audit_events WHERE event_id='ae_1'",
    );
    expect(rows[0]).toEqual({ workspace_id: NEW_ID, entity_id: NEW_ID });
  });

  it("renames + rewrites OAuth grant scopes to granted_workspace_*", async () => {
    const { rows } = await db.query<{
      granted_workspace_ids: string[];
      granted_workspace_roles: Record<string, string>;
    }>(
      "SELECT granted_workspace_ids, granted_workspace_roles FROM oauth_access_tokens WHERE token='tok_1'",
    );
    expect(rows[0].granted_workspace_ids).toEqual([NEW_ID]);
    expect(rows[0].granted_workspace_roles).toEqual({ [NEW_ID]: "reader" });
  });

  it("rewrites organization_ ids embedded in the invite blob", async () => {
    const { rows } = await db.query<{ blob: Record<string, string> }>(
      "SELECT blob FROM tokens_blob WHERE key='invite_1'",
    );
    expect(rows[0].blob).toEqual({ org_id: NEW_ID });
  });

  it("migrates group-chat target_level 'org' -> 'workspace' and rewrites target_id", async () => {
    const { rows } = await db.query(
      "SELECT target_level, target_id FROM group_chat_channel_connections WHERE id='gcc_1'",
    );
    expect(rows[0]).toEqual({ target_level: "workspace", target_id: NEW_ID });
    // The CHECK now rejects the old value.
    await expect(
      db.query("UPDATE group_chat_channel_connections SET target_level='org' WHERE id='gcc_1'"),
    ).rejects.toThrow();
  });

  it("keeps the workspace_id foreign key enforced after the rewrite", async () => {
    await expect(
      db.query(
        "INSERT INTO docos (id, handle, owner_id, workspace_id) VALUES ('doco_x','x','x','workspace_missing')",
      ),
    ).rejects.toThrow();
    await db.query("DELETE FROM workspaces WHERE id=$1", [NEW_ID]);
    const docos = await db.query("SELECT 1 FROM docos WHERE id='doco_1'");
    expect(docos.rows).toEqual([]);
  });

  it("leaves no organization_ ids behind", async () => {
    const ws = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM workspaces WHERE id LIKE 'organization_%'",
    );
    expect(ws.rows[0].n).toBe(0);
  });

  it("rewrites the seeded 'in this organization' wording in stored constitutions", async () => {
    const { rows } = await db.query<{ constitution: string }>(
      "SELECT constitution FROM workspaces WHERE id=$1",
      [NEW_ID],
    );
    expect(rows[0].constitution).toBe(
      "Follow the policies of every Doco in this workspace. They are binding.",
    );
  });

  it("keeps the org-CHART perspective (perspective_org_tree) intact", async () => {
    const { rows } = await db.query(
      "SELECT kind, name FROM perspectives WHERE id='perspective_org_tree'",
    );
    expect(rows[0]).toEqual({ kind: "org-tree", name: "Org Tree" });
  });
});
