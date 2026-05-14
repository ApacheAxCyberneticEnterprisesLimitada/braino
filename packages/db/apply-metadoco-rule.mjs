// One-shot: append the scope-manifest-visibility rule to the meta-Doco's
// (torrenegra/doco) Constitution scope in Postgres. Idempotent — exits
// early if the rule's spec is already present.
//
// Run via: node /Users/torrenegra/Doco/packages/db/apply-metadoco-rule.mjs
// Reads DOCO_DATABASE_URL from env (falls back to dev default).

import pg from "pg";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const yamlMod = require("/Users/torrenegra/Doco/node_modules/.pnpm/yaml@2.8.4/node_modules/yaml");
const parseYaml = yamlMod.parse;
const stringifyYaml = yamlMod.stringify;

const { Pool } = pg;

const SCOPE_ID = "scope_01KRFFRD3SQ80T93RSE3T4GHG2";

const NEW_RULE = {
  kind: "probabilistic",
  spec:
    "Behavioral reminder, not a per-node check — agents are expected to surface the Doco's scope manifest to the project owner at session start and whenever the conversation moves into new territory, and to flag drift in the watched set.",
  reason:
    "Agents must proactively surface this Doco's scope manifest to the project owner — naming each scope, its purpose, and which carry the `watched` flag — and remind them that watched scopes only stay load-bearing when the project owner reviews them as the project evolves, retiring stale ones, sharpening vague ones, and adding new ones whose absence would let real work slip out of view.",
};

const url =
  process.env.DOCO_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:doco@127.0.0.1:5433/doco";
const pool = new Pool({ connectionString: url });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const sel = await client.query(
    "SELECT id, name, raw_yaml, revision FROM scopes WHERE id = $1 FOR UPDATE",
    [SCOPE_ID],
  );
  if (sel.rowCount === 0) {
    console.error(`✗ Scope ${SCOPE_ID} not found in Postgres.`);
    process.exit(1);
  }
  const row = sel.rows[0];
  if (row.name !== "constitution") {
    console.error(`✗ Expected scope name=constitution but got ${row.name}.`);
    process.exit(1);
  }
  const yaml = parseYaml(row.raw_yaml);
  const existing = Array.isArray(yaml.rules) ? yaml.rules : [];
  if (existing.some((r) => r && r.kind === "probabilistic" && r.spec === NEW_RULE.spec)) {
    console.log("✓ Rule already present — no change.");
    await client.query("COMMIT");
    process.exit(0);
  }
  yaml.rules = [...existing, NEW_RULE];
  const newYaml = stringifyYaml(yaml);
  const upd = await client.query(
    "UPDATE scopes SET raw_yaml = $1, revision = revision + 1, updated_at = now() WHERE id = $2 AND revision = $3 RETURNING revision",
    [newYaml, SCOPE_ID, row.revision],
  );
  if (upd.rowCount !== 1) {
    throw new Error("Optimistic update failed — revision changed underneath us.");
  }
  await client.query("COMMIT");
  console.log(
    `✓ Appended scope-manifest-visibility rule to ${SCOPE_ID} (${row.name}). New revision: ${upd.rows[0].revision}.`,
  );
  console.log(`  Rules in scope now: ${yaml.rules.length}`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("✗ Failed:", e.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
