// Validates the doco-vnext GENESIS RESET against real Postgres.
//
// Seeds a simulated pre-vnext prod DB (old-named tables + data + a populated
// migration ledger), then runs the REAL ensureSchema() bookend and asserts a
// clean full-wipe reset to the new schema.
//
//   LC_ALL=C pnpm exec tsx packages/db/scripts/vnext-migrate-test.ts
//   (drop+recreate the `doco` db first for a clean run)

import pg from "pg";
import { closePool, ensureSchema, withClient } from "../src/index.js";

const URL = process.env.DOCO_DATABASE_URL ?? "postgres://postgres:doco@127.0.0.1:5433/doco";

let passed = 0;
function check(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}

async function seedDirtyOldProd(): Promise<void> {
  const pool = new pg.Pool({ connectionString: URL, max: 2 });
  const c = await pool.connect();
  try {
    await c.query(
      "CREATE TABLE IF NOT EXISTS applied_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await c.query(
      `INSERT INTO applied_migrations (id) VALUES
         ('001_principal_type_person'),('055_rename_collaborator_to_user'),('062_per_type_write_grants')
       ON CONFLICT DO NOTHING`,
    );
    await c.query(
      "CREATE TABLE IF NOT EXISTS synapses (from_id text, to_id text, synapse_type text)",
    );
    await c.query(`INSERT INTO synapses VALUES ('a','b','serves')`);
    await c.query("CREATE TABLE IF NOT EXISTS neuron_authoring_policies (id text PRIMARY KEY)");
    await c.query(
      `CREATE TABLE IF NOT EXISTS decisions (id text PRIMARY KEY, doco_id text, lifecycle text,
         decision text, data jsonb, created_at timestamptz, created_by text, updated_at timestamptz, updated_by text)`,
    );
    await c.query(
      `INSERT INTO decisions (id, doco_id, decision, data) VALUES ('decision_old','d','old data','{}')`,
    );
  } finally {
    c.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  await seedDirtyOldProd();
  await ensureSchema(); // bookend: schema → genesis 063 → schema

  await withClient(async (c) => {
    const tbl = async (name: string): Promise<boolean> =>
      (await c.query<{ x: string | null }>("SELECT to_regclass($1) AS x", [`public.${name}`]))
        .rows[0].x !== null;

    check("old synapses table dropped", !(await tbl("synapses")));
    check("old neuron_authoring_policies dropped", !(await tbl("neuron_authoring_policies")));
    check("new edges table present", await tbl("edges"));
    check("new changesets present", await tbl("changesets"));
    check("new node_versions present", await tbl("node_versions"));
    check("new edge_versions present", await tbl("edge_versions"));
    check("renamed node_authoring_policies present", await tbl("node_authoring_policies"));
    check("renamed entity_fts_nodes present", await tbl("entity_fts_nodes"));

    const dec = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM decisions");
    check("decisions wiped (FULL reset)", dec.rows[0].n === 0);

    const mig = await c.query<{ id: string }>("SELECT id FROM applied_migrations");
    const ids = mig.rows.map((r) => r.id);
    check("genesis 063 recorded", ids.includes("063_genesis_reset"));
    check(
      "prior ledger ids preserved (forward-only)",
      ids.includes("001_principal_type_person") && ids.includes("062_per_type_write_grants"),
    );

    const cols = await c.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='edges'",
    );
    const colset = cols.rows.map((r) => r.column_name);
    check(
      "edges is first-class (id + lifecycle + props + provenance)",
      ["id", "lifecycle", "props", "created_by", "retired_at"].every((x) => colset.includes(x)),
    );
  });

  await closePool();
  console.log(`\n✅ migrate test: ${passed} checks passed (dirty old-prod → clean vnext reset).`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
