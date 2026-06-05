// Smoke test for the append-only edge runtime, run against a
// real local Postgres (the schema must already be applied).
//
//   LC_ALL=C DOCO_DATABASE_URL=postgres://postgres:doco@127.0.0.1:5433/doco \
//     pnpm exec tsx packages/db/scripts/history-smoke.ts
//
// Uses a raw pg Pool (NOT @doco/db's getPool) so we validate the
// runtime against the already-applied schema.sql directly.

import { generateUlid, makeEntityId } from "@doco/shared";
import pg from "pg";
import {
  appendNodeVersion,
  createChangeset,
  createEdge,
  entityAsOf,
  getVersions,
  retireEdge,
  updateEdge,
} from "../src/history.js";

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
    // Clean slate for a repeatable run.
    await c.query("BEGIN");
    const workspaceId = makeEntityId("workspace", generateUlid());
    const userId = makeEntityId("user", generateUlid());
    const docoId = makeEntityId("doco", generateUlid());
    const decisionId = makeEntityId("decision", generateUlid());
    const refId = makeEntityId("reference", generateUlid());

    await c.query(`INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,'{}')`, [
      workspaceId,
      `workspace-${generateUlid().slice(0, 8).toLowerCase()}`,
      "Smoke Workspace",
    ]);
    await c.query(`INSERT INTO users (id, data) VALUES ($1,'{}')`, [userId]);
    await c.query(
      `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, goal, data)
       VALUES ($1,$2,$3,$4,'private','smoke','{}')`,
      [docoId, `doco-${generateUlid().slice(0, 8).toLowerCase()}`, workspaceId, workspaceId],
    );
    await c.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_by)
       VALUES ($1,$2,'decision','active','Use first-class edges',$3)`,
      [decisionId, docoId, userId],
    );
    await c.query(
      `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_by)
       VALUES ($1,$2,'reference','active','PR #634',$3)`,
      [refId, docoId, userId],
    );

    // --- Node version on create (proves node history) ---
    const tx0 = await createChangeset(c, {
      docoId,
      actor: userId,
      source: "system",
      reason: "seed: create decision",
    });
    await appendNodeVersion(c, {
      entityId: decisionId,
      entityType: "decision",
      op: "create",
      payload: { id: decisionId, decision: "Use first-class edges", lifecycle: "active" },
      txId: tx0,
      actor: userId,
    });

    // --- Edge create (supports/implemented_by: decision -> reference) ---
    const tx1 = await createChangeset(c, {
      docoId,
      actor: userId,
      source: "api",
      reason: "link decision to the PR that ships it",
    });
    const edge = await createEdge(c, tx1, {
      docoId,
      edgeType: "supports",
      fromId: decisionId,
      fromNodeType: "decision",
      toId: refId,
      toNodeType: "reference",
      label: "ships in PR #634",
      actor: userId,
    });
    check("edge has surrogate id edge_<ulid>", /^edge_[0-9A-HJKMNP-TV-Z]{26}$/.test(edge.id));
    check("edge created lifecycle=asserted", edge.lifecycle === "active");
    check("edge carries provenance created_by", edge.created_by === userId);

    // --- Edge update (props mutation) ---
    const tx2 = await createChangeset(c, {
      docoId,
      actor: userId,
      source: "api",
      reason: "annotate",
    });
    const updated = await updateEdge(c, tx2, {
      id: edge.id,
      label: "ships in PR #634 (verified)",
      actor: userId,
    });
    check(
      "edge update kept endpoints immutable",
      updated.from_id === decisionId && updated.to_id === refId,
    );
    check("edge update changed label", updated.label === "ships in PR #634 (verified)");

    // --- Live-unique: a second LIVE duplicate must be rejected ---
    let dupRejected = false;
    try {
      await c.query("SAVEPOINT dup");
      await createEdge(c, tx2, {
        docoId,
        edgeType: "supports",
        fromId: decisionId,
        fromNodeType: "decision",
        toId: refId,
        toNodeType: "reference",
        actor: userId,
      });
      await c.query("RELEASE SAVEPOINT dup");
    } catch {
      dupRejected = true;
      await c.query("ROLLBACK TO SAVEPOINT dup");
    }
    check("duplicate LIVE edge rejected by live-unique index", dupRejected);

    // --- Retire (the only "delete") ---
    const tx3 = await createChangeset(c, {
      docoId,
      actor: userId,
      source: "api",
      reason: "superseded",
    });
    const retired = await retireEdge(c, tx3, { id: edge.id, actor: userId });
    check("retire sets lifecycle=retired", retired.lifecycle === "retired");
    check("retire stamps retired_at", retired.retired_at !== null);

    // Row still present — retire is NOT delete.
    const stillThere = await c.query("SELECT 1 FROM edges WHERE id = $1", [edge.id]);
    check("retired edge row still exists (nothing deleted)", stillThere.rowCount === 1);

    // --- After retire, the live slot is free: recreate succeeds ---
    const tx4 = await createChangeset(c, {
      docoId,
      actor: userId,
      source: "api",
      reason: "re-link",
    });
    const recreated = await createEdge(c, tx4, {
      docoId,
      edgeType: "supports",
      fromId: decisionId,
      fromNodeType: "decision",
      toId: refId,
      toNodeType: "reference",
      props: { role: "implemented_by" },
      actor: userId,
    });
    check("recreate after retire succeeds (live slot freed)", recreated.id !== edge.id);

    // --- Version history: create + update + retire = 3 ---
    const edgeVersions = await getVersions(c, "edge", edge.id);
    check(
      "edge has full append-only history (create,update,retire)",
      edgeVersions.length === 3 &&
        edgeVersions.map((v) => v.op).join(",") === "create,update,retire",
    );
    const nodeVersions = await getVersions(c, "node", decisionId);
    check(
      "node has a version snapshot",
      nodeVersions.length === 1 && nodeVersions[0].op === "create",
    );

    // --- Commit log: monotonic tx_ids carrying the "why" ---
    const cs = await c.query<{ tx_id: string; reason: string }>(
      "SELECT tx_id, reason FROM changesets WHERE doco_id = $1 ORDER BY tx_id ASC",
      [docoId],
    );
    check("commit log recorded all changesets", cs.rowCount === 5);
    check(
      "tx_ids are monotonic",
      cs.rows.every((r, i) => i === 0 || Number(r.tx_id) > Number(cs.rows[i - 1].tx_id)),
    );
    check(
      "commit log carries the 'why'",
      cs.rows[1].reason === "link decision to the PR that ships it",
    );

    // --- Time-travel: as-of the edge's first commit shows the original props ---
    const asOfCreate = await entityAsOf(c, "edge", edge.id, tx1);
    check("as-of tx1 reconstructs the create snapshot", asOfCreate?.op === "create");
    const asOfRetire = await entityAsOf(c, "edge", edge.id, tx3);
    check("as-of tx3 reconstructs the retire snapshot", asOfRetire?.op === "retire");

    await c.query("ROLLBACK"); // leave the DB clean
    console.log(`\n✅ history smoke: ${passed} checks passed against real Postgres.`);
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
