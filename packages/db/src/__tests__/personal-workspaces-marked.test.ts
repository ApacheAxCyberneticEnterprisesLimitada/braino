// Signing up used to create a personal workspace named after the person; it no
// longer does (decision_01M4GF757E9T2X902JZKYG0DKG). The ones people already
// have keep being theirs, so schema.sql marks each once with whose it is
// (workspaces.personal_user_id): the workspaces whose handle was their GitHub
// login when the column arrived. Nothing marks a workspace after that, so one
// a person later names after themselves is an ordinary workspace.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

let db: PGlite;

async function personalOf(id: string): Promise<string | null> {
  const r = await db.query<{ personal_user_id: string | null }>(
    "SELECT personal_user_id FROM workspaces WHERE id = $1",
    [id],
  );
  return r.rows[0]?.personal_user_id ?? null;
}

describe("personal workspaces are marked once with whose they are", () => {
  beforeEach(async () => {
    db = await freshDb();
    // A database from before the column.
    await db.exec(`
      ALTER TABLE workspaces DROP COLUMN personal_user_id;
      INSERT INTO users (id, github_login, data) VALUES
        ('user_ana', 'Ana', '{}'), ('user_bo', 'bo', '{}');
      INSERT INTO workspaces (id, handle, name) VALUES
        ('workspace_ana', 'ana', 'ana'), ('workspace_acme', 'acme', 'acme');
    `);
  });

  it("marks the workspace named after a person as theirs, and no other", async () => {
    await db.exec(schemaSql);
    expect(await personalOf("workspace_ana")).toBe("user_ana");
    expect(await personalOf("workspace_acme")).toBeNull();
  });

  it("never marks a workspace made after it ran", async () => {
    await db.exec(schemaSql);
    await db.exec(`INSERT INTO workspaces (id, handle, name) VALUES ('workspace_bo', 'bo', 'bo')`);
    await db.exec(schemaSql);
    expect(await personalOf("workspace_bo")).toBeNull();
    expect(await personalOf("workspace_ana")).toBe("user_ana");
  });
});
