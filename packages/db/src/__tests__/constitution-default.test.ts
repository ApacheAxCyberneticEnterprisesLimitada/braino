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

  it("schema.sql declares workspaces.constitution and not collections.constitution", () => {
    const workspaceBlock = schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?workspaces\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(workspaceBlock, "workspaces CREATE TABLE not found in schema.sql").toBeTruthy();
    expect(workspaceBlock).toMatch(/\bconstitution\s+text\b/);

    const collectionBlock = schemaSql.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?collections\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(collectionBlock, "collections CREATE TABLE not found in schema.sql").toBeTruthy();
    expect(collectionBlock).not.toMatch(/\bconstitution\s+text\b/);
  });

  it("asks agents to follow every collection's policies and document for a future collaborator", () => {
    expect(text).toMatch(/policies of every collection/i);
    expect(text).toMatch(/future collaborator/i);
  });

  // Alexander, 2026-10-21: "the instructions shouldn't make reference to it.
  // The Constitutions should." Doco's agent instructions name no collection,
  // so the constitution says what to record and in which of the collections
  // a new workspace starts with.
  it("says what to record and where: each chat, each decision by its kind, each process change", () => {
    expect(text).toContain(
      "Record each chat as a Log in Agents chats, in one short line: who asked for what and what came of it.",
    );
    expect(text).toContain("Record each decision as it is made");
    expect(text).toContain(
      "When a decision changes a business process, change that process in Processes too",
    );
  });

  // An agent filed a change to what non-USD Pros are paid in Architectural
  // decisions because it shipped as code (decision_01M5AXEZ2JHCPGTP3NNY2C16QV).
  // A decision goes where what was chosen belongs, and a choice with a product
  // side and a technical side is two Decisions.
  it("files a decision by what was chosen, not by the code it took", () => {
    expect(text).toContain(
      "- Product decisions when it sets what users or the business get (what to build, fix, charge or pay), even when it ships as code;",
    );
    expect(text).toContain("- Design decisions when it sets how something looks or behaves");
    expect(text).toContain(
      "- Architectural decisions when it sets how the system does it: structure, technology, data;",
    );
    expect(text).toContain(
      "- Security decisions when it sets how the system and its data are protected: who gets access, secrets, threats, and the risks accepted.",
    );
    expect(text).toContain(
      "A choice with both sides is two Decisions, each citing the other's id.",
    );
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
