// Guard: the default constitution text has THREE copies that must stay in
// sync — the TS constant (DEFAULT_DOCO_CONSTITUTION, the canonical source,
// applied to new Docos by createDocoInOrg), the schema.sql column, and the
// migration-068 backfill that seeds existing rows. SQL can't import the TS
// constant, so this test reads all three from disk and asserts they agree.
//
// Compared as files (no module import) so it runs without building
// @doco/shared to dist.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const constitutionTs = readFileSync(
  join(here, "..", "..", "..", "shared", "src", "constitution.ts"),
  "utf8",
);
const migrationSql = readFileSync(
  join(here, "..", "..", "migrations", "068_doco_constitution.sql"),
  "utf8",
);
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

/** Pull the template-literal body of DEFAULT_DOCO_CONSTITUTION from source. */
function defaultConstitutionText(): string {
  const m = constitutionTs.match(/DEFAULT_DOCO_CONSTITUTION\s*=\s*`([\s\S]*?)`;/);
  if (!m?.[1]) throw new Error("Could not locate DEFAULT_DOCO_CONSTITUTION in constitution.ts");
  return m[1];
}

describe("default constitution text stays in sync", () => {
  const text = defaultConstitutionText();

  it("migration 068 backfills with the exact DEFAULT_DOCO_CONSTITUTION text", () => {
    // The migration dollar-quotes the same body; substring match is enough.
    expect(migrationSql).toContain(text);
  });

  it("schema.sql declares the docos.constitution column", () => {
    const block = schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?docos\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(block, "docos CREATE TABLE not found in schema.sql").toBeTruthy();
    expect(block).toMatch(/\bconstitution\s+text\b/);
  });

  it("migration 068 adds the column idempotently", () => {
    expect(migrationSql).toMatch(/ADD COLUMN IF NOT EXISTS constitution text/);
  });

  it("the default text carries the three intended themes", () => {
    expect(text).toMatch(/spec-driven/i);
    expect(text).toMatch(/policies of every Doco/i);
    expect(text).toMatch(/future collaborator/i);
  });
});
