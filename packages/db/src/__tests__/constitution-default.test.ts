// Guard the default org-constitution text and its schema home.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const constitutionTs = readFileSync(
  join(here, "..", "..", "..", "shared", "src", "constitution.ts"),
  "utf8",
);
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

/** Pull the template-literal body of DEFAULT_ORG_CONSTITUTION from source. */
function defaultConstitutionText(): string {
  const m = constitutionTs.match(/DEFAULT_ORG_CONSTITUTION\s*=\s*`([\s\S]*?)`;/);
  if (!m?.[1]) throw new Error("Could not locate DEFAULT_ORG_CONSTITUTION in constitution.ts");
  return m[1];
}

describe("default org constitution text stays in sync", () => {
  const text = defaultConstitutionText();

  it("schema.sql declares organizations.constitution and not docos.constitution", () => {
    const orgBlock = schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?organizations\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(orgBlock, "organizations CREATE TABLE not found in schema.sql").toBeTruthy();
    expect(orgBlock).toMatch(/\bconstitution\s+text\b/);

    const docoBlock = schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?docos\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(docoBlock, "docos CREATE TABLE not found in schema.sql").toBeTruthy();
    expect(docoBlock).not.toMatch(/\bconstitution\s+text\b/);
  });

  it("the default text carries the three intended themes", () => {
    expect(text).toMatch(/spec-driven/i);
    expect(text).toMatch(/policies of every Doco/i);
    expect(text).toMatch(/future collaborator/i);
  });
});
