// A route names a collection by id or by handle. Collections minted before the
// unit was called a collection keep the id they were given, under its older
// prefix, so resolving an id reads the prefix nowhere: ids carry an uppercase
// ULID and handles are lowercase, so one value can't be both.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import { getCollectionByIdOrHandle } from "../repo.js";

const NEW_ID = "collection_01KT1ZBP73GYF1VX7S7XF1RKHJ";
const OLDER_ID = "older_01KT1ZBP73GYF1VX7S7XF1RKHK";

describe("getCollectionByIdOrHandle", () => {
  beforeEach(async () => {
    mocks.db = await freshDb();
    await mocks.db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_w', 'w', 'W');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES
        ('${NEW_ID}', 'product', 'workspace_w', 'workspace_w', '{}'),
        ('${OLDER_ID}', 'bugs', 'workspace_w', 'workspace_w', '{}');
    `);
  });

  it("resolves an id whatever prefix it was minted with", async () => {
    expect((await getCollectionByIdOrHandle(NEW_ID))?.handle).toBe("product");
    expect((await getCollectionByIdOrHandle(OLDER_ID))?.handle).toBe("bugs");
  });

  it("resolves a handle, and nothing for one no collection has", async () => {
    expect((await getCollectionByIdOrHandle("bugs"))?.id).toBe(OLDER_ID);
    expect(await getCollectionByIdOrHandle("nowhere")).toBeNull();
  });
});
