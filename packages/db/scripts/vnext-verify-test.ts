// Validates the Merkle tamper-evidence chain on edge/node history.
//   DOCO_DATABASE_URL=postgres://postgres:doco@127.0.0.1:5433/doco \
//     pnpm exec tsx packages/db/scripts/vnext-verify-test.ts

import { generateUlid, makeEntityId } from "@doco/shared";
import pg from "pg";
import { createChangeset, createEdge, updateEdge, verifyHistory } from "../src/index.js";

const URL = process.env.DOCO_DATABASE_URL ?? "postgres://postgres:doco@127.0.0.1:5433/doco";
const pool = new pg.Pool({ connectionString: URL, max: 4 });
let passed = 0;
function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

async function main(): Promise<void> {
  const c = await pool.connect();
  try {
    const orgId = makeEntityId("organization", generateUlid());
    const userId = makeEntityId("user", generateUlid());
    const docoId = makeEntityId("doco", generateUlid());
    const dId = makeEntityId("decision", generateUlid());
    const rId = makeEntityId("reference", generateUlid());
    await c.query(`INSERT INTO organizations (id,handle,name,data) VALUES ($1,$2,'O','{}')`, [
      orgId,
      `o-${generateUlid().slice(0, 8).toLowerCase()}`,
    ]);
    await c.query(`INSERT INTO users (id,kind,data) VALUES ($1,'person','{}')`, [userId]);
    await c.query(
      `INSERT INTO docos (id,handle,owner_id,org_id,visibility,goal,data) VALUES ($1,$2,$3,$4,'private','g','{}')`,
      [docoId, `d-${generateUlid().slice(0, 8).toLowerCase()}`, orgId, orgId],
    );
    await c.query(
      `INSERT INTO nodes (id,doco_id,node_type,lifecycle,prose,data) VALUES ($1,$2,'decision','asserted','D','{}')`,
      [dId, docoId],
    );
    await c.query(
      `INSERT INTO nodes (id,doco_id,node_type,lifecycle,prose,data) VALUES ($1,$2,'reference','asserted','R','{}')`,
      [rId, docoId],
    );

    const edge = await (async () => {
      const tx = await createChangeset(c, {
        docoId,
        actor: userId,
        source: "api",
        reason: "create",
      });
      const e = await createEdge(c, tx, {
        docoId,
        edgeType: "implemented_by",
        fromId: dId,
        fromNodeType: "decision",
        toId: rId,
        toNodeType: "reference",
        actor: userId,
      });
      const tx2 = await createChangeset(c, {
        docoId,
        actor: userId,
        source: "api",
        reason: "annotate",
      });
      await updateEdge(c, tx2, { id: e.id, props: { note: "x" }, actor: userId });
      return e;
    })();

    const v1 = await verifyHistory(c, "edge", edge.id);
    check("intact chain verifies ok", v1.ok === true && v1.versions === 2);

    // Tamper with a past version (requires disabling the append-only trigger —
    // proving the chain catches edits the guardrail would normally block).
    await c.query("ALTER TABLE edge_versions DISABLE TRIGGER edge_versions_append_only_row");
    await c.query(
      `UPDATE edge_versions SET payload = '{"tampered":true}'::jsonb WHERE entity_id=$1 AND version=1`,
      [edge.id],
    );
    await c.query("ALTER TABLE edge_versions ENABLE TRIGGER edge_versions_append_only_row");

    const v2 = await verifyHistory(c, "edge", edge.id);
    check("tampered chain is detected", v2.ok === false && v2.brokenAtVersion === 1);

    console.log(`\n✅ verify test: ${passed} checks passed against real Postgres.`);
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
