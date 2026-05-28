import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../client.js", () => ({
  withClient: (fn: (client: { query: typeof mocks.query }) => unknown) =>
    fn({ query: mocks.query }),
}));

import { readAuditEventRows } from "../repo.js";

describe("readAuditEventRows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it("applies before as an exclusive pagination cursor", async () => {
    await readAuditEventRows({
      doco_id: "doco_bpms",
      before: "2026-05-27T13:33:27.000Z",
      limit: 50,
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, values] = mocks.query.mock.calls[0] ?? [];
    expect(sql).toContain("doco_id = $1");
    expect(sql).toContain("at < $2");
    expect(sql).toContain("ORDER BY at DESC");
    expect(sql).toContain("LIMIT $3");
    expect(values).toEqual(["doco_bpms", "2026-05-27T13:33:27.000Z", 50]);
  });
});
