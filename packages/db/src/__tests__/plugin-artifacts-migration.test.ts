import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("plugin artifact migration", () => {
  it("keeps old digest claims inert while enforcing artifacts for new installations", async () => {
    await db.exec(`
      ALTER TABLE plugin_installations
        DROP CONSTRAINT plugin_installations_artifact_digest_fkey;
      DROP TABLE plugin_artifacts;
      INSERT INTO workspaces (id, handle, name, constitution)
      VALUES ('workspace_test', 'test', 'Test', '');
      INSERT INTO users (id, username, name, email, password_hash, data)
      VALUES ('user_test', 'test', 'Test', 'test@example.com', 'hash', '{}');
      INSERT INTO plugin_installations
        (id, workspace_id, manifest, artifact_digest,
         created_by_user_id, updated_by_user_id)
      VALUES
        ('plugin_installation_old', 'workspace_test', '{"id":"example.old"}',
         'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'user_test', 'user_test');
    `);

    const migration = await readFile(
      new URL("../../migrations/014_plugin_artifacts.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    const constraint = await db.query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = 'plugin_installations_artifact_digest_fkey'`,
    );
    expect(constraint.rows).toEqual([{ convalidated: false }]);
    await expect(
      db.query(
        `INSERT INTO plugin_installations
          (id, workspace_id, manifest, artifact_digest,
           created_by_user_id, updated_by_user_id)
         VALUES
          ('plugin_installation_new', 'workspace_test', '{"id":"example.new"}',
           'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
           'user_test', 'user_test')`,
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query<{ id: string }>(
          "SELECT id FROM plugin_installations WHERE id = 'plugin_installation_old'",
        )
      ).rows,
    ).toEqual([{ id: "plugin_installation_old" }]);
  });
});
