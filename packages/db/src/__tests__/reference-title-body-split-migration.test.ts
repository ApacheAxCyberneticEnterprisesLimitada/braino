// Title/body split migration: PR references were stored prose = "title\n\nbody".
// The split moves the body into attributes.body_md, leaving prose = the title.
// schema.sql re-applies on every boot, so the migration must be idempotent and
// tightly scoped to PR-URL references (so hand-written or code-locator
// references — and rows already split — are never touched). This loads the real
// schema.sql into PGlite and pins all five cases.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "..", "schema.sql"), "utf8");

const DOCO = "doco_refsplit0000000000000000000";
const ORG = "workspace_refsplit00000000000";

let db: PGlite;

async function insertReference(
  id: string,
  prose: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, attributes)
     VALUES ($1, $2, 'reference', 'active', $3, $4::jsonb)`,
    [id, DOCO, prose, JSON.stringify(attributes)],
  );
}

async function readNode(
  id: string,
): Promise<{ prose: string; attributes: Record<string, unknown> }> {
  const r = await db.query<{ prose: string; attributes: Record<string, unknown> }>(
    "SELECT prose, attributes FROM nodes WHERE id = $1",
    [id],
  );
  return r.rows[0];
}

const PR_LOCATOR = "https://github.com/acme/store/pull/482";

beforeEach(async () => {
  db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name, data) VALUES ($1,$2,$3,'{}'::jsonb)", [
    ORG,
    "workspace-refsplit",
    "Workspace RefSplit",
  ]);
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ($1,$2,$3,$4,'{}'::jsonb)",
    [DOCO, "doco-refsplit", ORG, ORG],
  );
});

describe("reference title/body split migration", () => {
  it("(a) splits a PR reference: prose=title, attributes.body_md=body (body keeps inner blank lines)", async () => {
    await insertReference("reference_split00000000000000000", "T\n\nB1\n\nB2", {
      ref_type: "url",
      locator: PR_LOCATOR,
    });

    await db.exec(schemaSql); // re-apply (what every boot does)

    const row = await readNode("reference_split00000000000000000");
    expect(row.prose).toBe("T");
    // Everything after the FIRST blank line is the body — inner blank lines kept.
    expect(row.attributes.body_md).toBe("B1\n\nB2");
    // The scalar attributes are untouched.
    expect(row.attributes).toMatchObject({ ref_type: "url", locator: PR_LOCATOR });
  });

  it("(b) is idempotent — re-applying schema.sql does not re-split", async () => {
    await insertReference("reference_idem000000000000000000", "T\n\nbody text", {
      ref_type: "url",
      locator: PR_LOCATOR,
    });

    await db.exec(schemaSql);
    const once = await readNode("reference_idem000000000000000000");
    await db.exec(schemaSql);
    const twice = await readNode("reference_idem000000000000000000");

    expect(once).toEqual(twice);
    expect(twice.prose).toBe("T");
    expect(twice.attributes.body_md).toBe("body text");
  });

  it("(c) leaves a non-PR-URL reference untouched (hand-written / code-locator)", async () => {
    // A code-locator reference whose prose happens to contain a blank line.
    await insertReference("reference_code000000000000000000", "Title\n\nBody", {
      ref_type: "code",
      locator: "src/index.ts:1-20",
    });
    // A reference with no locator at all.
    await insertReference("reference_nolocator00000000000000", "Note\n\nMore", {
      ref_type: "text",
    });

    await db.exec(schemaSql);

    const code = await readNode("reference_code000000000000000000");
    expect(code.prose).toBe("Title\n\nBody");
    expect(code.attributes).not.toHaveProperty("body_md");

    const noLoc = await readNode("reference_nolocator00000000000000");
    expect(noLoc.prose).toBe("Note\n\nMore");
    expect(noLoc.attributes).not.toHaveProperty("body_md");
  });

  it("(d) leaves an already-split reference untouched (body_md present)", async () => {
    await insertReference("reference_done000000000000000000", "Just the title", {
      ref_type: "url",
      locator: PR_LOCATOR,
      body_md: "Already the body.",
    });

    await db.exec(schemaSql);

    const row = await readNode("reference_done000000000000000000");
    expect(row.prose).toBe("Just the title");
    expect(row.attributes.body_md).toBe("Already the body.");
  });

  it("(e) leaves a PR reference with no blank line in prose untouched", async () => {
    await insertReference("reference_noblank00000000000000", "Title only, no body", {
      ref_type: "url",
      locator: PR_LOCATOR,
    });

    await db.exec(schemaSql);

    const row = await readNode("reference_noblank00000000000000");
    expect(row.prose).toBe("Title only, no body");
    expect(row.attributes).not.toHaveProperty("body_md");
  });

  it("scopes by the PR-URL shape — a github URL that is not a /pull/ link is untouched", async () => {
    await insertReference("reference_issue00000000000000000", "Issue\n\nBody", {
      ref_type: "url",
      locator: "https://github.com/acme/store/issues/7",
    });

    await db.exec(schemaSql);

    const row = await readNode("reference_issue00000000000000000");
    expect(row.prose).toBe("Issue\n\nBody");
    expect(row.attributes).not.toHaveProperty("body_md");
  });
});
