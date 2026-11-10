import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceRole, withClient } from "../index.js";
import { installTestDatabaseClient } from "../test-support.js";

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("database test support", () => {
  it("routes direct and repository queries through an installed test client", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [{ role: "writer" }], rowCount: 1 }),
    };
    restore = installTestDatabaseClient(client);

    expect(await withClient(async (database) => database === client)).toBe(true);
    expect(await getWorkspaceRole("workspace_test", "user_test")).toBe("writer");
    expect(client.query).toHaveBeenCalledWith(
      "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      ["workspace_test", "user_test"],
    );
  });
});
