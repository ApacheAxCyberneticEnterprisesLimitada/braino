// Existing workspaces were seeded with the default constitution of their day.
// When the three baseline duties (load context, document every decision,
// record every conversation) joined the default, Alexander asked that existing
// constitutions get them too — so schema.sql, which re-applies after every
// change to it, appends the duties paragraph to any constitution that lacks
// it. A workspace
// still on the old default ends up byte-identical to the new default; a
// customized one keeps its text and gains the paragraph at the end; one that
// already carries it is left alone, so a reboot changes nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";
import { schemaSql } from "./schema-sql.js";

const here = dirname(fileURLToPath(import.meta.url));
const constitutionTs = readFileSync(
  join(here, "..", "..", "..", "shared", "src", "constitution.ts"),
  "utf8",
);
const NEW_DEFAULT = (() => {
  const m = constitutionTs.match(/DEFAULT_WORKSPACE_CONSTITUTION\s*=\s*`([\s\S]*?)`;/);
  if (!m?.[1]) throw new Error("DEFAULT_WORKSPACE_CONSTITUTION not found");
  return m[1];
})();
const DUTIES = NEW_DEFAULT.slice(NEW_DEFAULT.lastIndexOf("\n\n") + 2);
const OLD_DEFAULT = NEW_DEFAULT.slice(0, NEW_DEFAULT.lastIndexOf("\n\n"));

let db: PGlite;

async function seed(id: string, constitution: string): Promise<void> {
  await db.query(
    "INSERT INTO workspaces (id, handle, name, constitution) VALUES ($1, $1, $1, $2)",
    [id, constitution],
  );
}

async function constitutionOf(id: string): Promise<string> {
  const r = await db.query<{ constitution: string }>(
    "SELECT constitution FROM workspaces WHERE id = $1",
    [id],
  );
  return r.rows[0]?.constitution ?? "";
}

describe("baseline duties join every existing constitution", () => {
  beforeEach(async () => {
    db = await freshDb();
  });

  it("the duties paragraph in schema.sql is the one constitution.ts ends with", () => {
    expect(DUTIES).toMatch(/^Three duties are not optional\./);
    expect(schemaSql).toContain(DUTIES);
  });

  it("upgrades an old-default constitution to exactly the new default", async () => {
    await seed("workspace_old", OLD_DEFAULT);
    await db.exec(schemaSql);
    expect(await constitutionOf("workspace_old")).toBe(NEW_DEFAULT);
  });

  it("appends the duties to a customized constitution and keeps its text", async () => {
    const custom = "We ship on Fridays.\n\nNever delete a Decision.";
    await seed("workspace_custom", custom);
    await seed("workspace_empty", "");
    await db.exec(schemaSql);
    expect(await constitutionOf("workspace_custom")).toBe(`${custom}\n\n${DUTIES}`);
    expect(await constitutionOf("workspace_empty")).toBe(DUTIES);
  });

  it("leaves a constitution that already carries the duties untouched across reboots", async () => {
    const edited = `Our own charter.\n\n${DUTIES}\n\nAnd a closing note the owner added after.`;
    await seed("workspace_new", NEW_DEFAULT);
    await seed("workspace_edited", edited);
    await db.exec(schemaSql);
    await db.exec(schemaSql);
    expect(await constitutionOf("workspace_new")).toBe(NEW_DEFAULT);
    expect(await constitutionOf("workspace_edited")).toBe(edited);
  });
});
