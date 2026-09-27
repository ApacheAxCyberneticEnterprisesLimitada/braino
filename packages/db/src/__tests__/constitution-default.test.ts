// Guard the default workspace-constitution text and its schema home.

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

/** Pull the template-literal body of DEFAULT_WORKSPACE_CONSTITUTION from source. */
function defaultConstitutionText(): string {
  const m = constitutionTs.match(/DEFAULT_WORKSPACE_CONSTITUTION\s*=\s*`([\s\S]*?)`;/);
  if (!m?.[1])
    throw new Error("Could not locate DEFAULT_WORKSPACE_CONSTITUTION in constitution.ts");
  return m[1];
}

describe("default workspace constitution text stays in sync", () => {
  const text = defaultConstitutionText();

  it("schema.sql declares workspaces.constitution and not docos.constitution", () => {
    const workspaceBlock = schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?workspaces\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(workspaceBlock, "workspaces CREATE TABLE not found in schema.sql").toBeTruthy();
    expect(workspaceBlock).toMatch(/\bconstitution\s+text\b/);

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

  it("names the baseline duties: load context, document decisions, record conversations", () => {
    expect(text).toMatch(/start of every (session|conversation)/i);
    expect(text).toMatch(/every decision/i);
    expect(text).toMatch(/record (every|each) conversation/i);
  });
});

describe("DEFAULT_WORKSPACE_CONSTITUTION voice", () => {
  it("never speaks in the first person", () => {
    const body = defaultConstitutionText();
    expect(body).not.toMatch(
      /(^|[^A-Za-z'’])(I|I['’](?:m|ll|ve|d)|[Mm]e|[Mm]y|[Mm]ine|[Ww]e|[Ww]e['’](?:re|ll|ve|d)|[Uu]s|[Oo]ur|[Oo]urs)(?=[^A-Za-z'’]|$)/,
    );
  });
});
