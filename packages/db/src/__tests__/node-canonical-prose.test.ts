import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { freshDb } from "./fresh-db.js";

// Slice 1 of the entity-shape normalization (docs/simplification-plan.md):
// a node's text has ONE name everywhere — `prose`. No `type_named_value`,
// no type-named key (`intent`/`decision`/…). The read path must surface the
// stored `prose` column as `data.prose`, so the field bag handed to the
// authoring-policy judge on RE-EVALUATION carries the text. The original bug:
// `rowToEntity` routed `prose` into a separate `type_named_value` property and
// the update/re-eval loader forwarded only `data`, so the judge saw a candidate
// with no text under any key ("the candidate lacks a `prose` field entirely").

const mocks = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("../client.js", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(mocks.db),
}));

import { getEntity, nodeRowFromFields, upsertNode } from "../repo.js";

const ORG = "workspace_prose000000000000000";
const DOCO = "doco_prose0000000000000000000000";

beforeAll(async () => {
  mocks.db = await freshDb();
  await mocks.db.query("INSERT INTO workspaces (id, handle, name) VALUES ($1, $2, $3)", [
    ORG,
    "workspace-prose",
    "Workspace Prose",
  ]);
  await mocks.db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-prose", ORG, ORG],
  );
});

describe("canonical node prose (slice 1)", () => {
  it("surfaces a stored node's text as data.prose on read — never a type-named key", async () => {
    const id = "intent_prose00000000000000000000";
    await upsertNode(
      nodeRowFromFields("intent", {
        id,
        doco_id: DOCO,
        node_type: "intent",
        prose: "Find candidates",
        lifecycle: "drafting",
      }),
      mocks.db as never,
    );

    const loaded = await getEntity("intent", id);
    expect(loaded).not.toBeNull();
    // The text comes back under the single canonical field…
    expect(loaded?.prose).toBe("Find candidates");
    // …and NOT under a legacy type-named key in `extra`.
    expect(loaded?.extra).not.toHaveProperty("intent");
  });

  it("the read-path field bag is a complete judge candidate — it carries the prose", async () => {
    const id = "intent_prose20000000000000000000";
    await upsertNode(
      nodeRowFromFields("intent", {
        id,
        doco_id: DOCO,
        node_type: "intent",
        prose: "Approve a loan",
        lifecycle: "active",
      }),
      mocks.db as never,
    );

    // The honest read row carries the text on read — the data a re-evaluation
    // flattens into the judge candidate.
    const loaded = await getEntity("intent", id);
    expect(loaded).toMatchObject({
      id,
      node_type: "intent",
      lifecycle: "active",
      prose: "Approve a loan",
    });
  });
});
