// A person's GitHub account, which Braino matches a pull request's author to,
// is recorded only after GitHub proves it. One account owns a login at a time.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (client: unknown) => unknown) => fn(mocks.db),
}));

import { setUserGitHubLogin } from "../repo.js";

const logins = async () =>
  (
    await mocks.db.query<{ id: string; github_login: string | null }>(
      "SELECT id, github_login FROM users ORDER BY id",
    )
  ).rows;

describe("setUserGitHubLogin", () => {
  beforeEach(async () => {
    mocks.db = await freshDb();
    await mocks.db.exec(`
      INSERT INTO users (id, username, github_login, data) VALUES
        ('user_ana', 'ana', 'ana-gh', '{}'),
        ('user_gus', 'gus', NULL, '{}'),
        ('user_old', 'old', 'gus657', '{}');
    `);
  });

  it("records the proven login and releases it from the previous account", async () => {
    await setUserGitHubLogin("user_gus", "Gus657");
    expect(await logins()).toEqual([
      { id: "user_ana", github_login: "ana-gh" },
      { id: "user_gus", github_login: "Gus657" },
      { id: "user_old", github_login: null },
    ]);
  });

  it("replaces the login the person had", async () => {
    await setUserGitHubLogin("user_ana", "ana-work");
    expect((await logins())[0]).toEqual({ id: "user_ana", github_login: "ana-work" });
  });
});
