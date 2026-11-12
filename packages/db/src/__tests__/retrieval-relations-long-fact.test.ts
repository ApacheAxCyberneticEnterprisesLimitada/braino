import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { type RetrievalDocumentInput, ingestRetrievalDocument } from "../retrieval-graph.js";
import { freshDb } from "./fresh-db.js";

const COLLECTION_ID = "collection_long_facts";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_long_facts', 'long-facts', 'Long facts');
    INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data)
      VALUES ('${COLLECTION_ID}', 'long-facts-codebase', 'workspace_long_facts',
              'workspace_long_facts', 'private', '{}'::jsonb);
  `);
});

/** A repository link whose fact cites as much evidence as a large codebase
 * gives: far past the 2,704 bytes a btree index entry may hold, and random,
 * so Postgres can't compress it under that limit. */
function repositoryLink(): RetrievalDocumentInput {
  const evidence = Array.from(
    { length: 40 },
    (_, line) => `acme/gateway/src/routes.ts:${line + 1} — ${randomBytes(90).toString("base64")}`,
  ).join("; ");
  const fact = `acme/gateway calls acme/crawler. Evidence: ${evidence}`;
  return {
    collectionId: COLLECTION_ID,
    source: "code_graph",
    externalId: "repository-graph",
    content: fact,
    chunks: [{ text: fact }],
    extraction: {
      entities: [
        {
          key: "gateway",
          name: "acme/gateway",
          type: "code_repository",
          mentions: [{ chunkIndex: 0 }],
        },
        {
          key: "crawler",
          name: "acme/crawler",
          type: "code_repository",
          mentions: [{ chunkIndex: 0 }],
        },
      ],
      relationships: [{ fromKey: "gateway", toKey: "crawler", type: "calls", fact, chunkIndex: 0 }],
    },
  };
}

describe("retrieval relationships with long facts", () => {
  it("keeps a relationship whose fact is longer than a btree entry can hold", async () => {
    const document = repositoryLink();
    const fact = document.extraction.relationships[0]?.fact ?? "";
    expect(Buffer.byteLength(fact)).toBeGreaterThan(2704);

    await ingestRetrievalDocument(db, document);
    await ingestRetrievalDocument(db, document);

    const relations = await db.query<{ relation_type: string; fact: string }>(
      "SELECT relation_type, fact FROM retrieval_relations WHERE collection_id = $1",
      [COLLECTION_ID],
    );
    expect(relations.rows).toEqual([{ relation_type: "calls", fact }]);
  });

  it("drops the unique key on the fact from an existing database", async () => {
    await db.exec(`
      DROP INDEX retrieval_relations_source_chunk_idx;
      ALTER TABLE retrieval_relations
        ADD UNIQUE (source_chunk_id, from_entity_id, to_entity_id, relation_type, fact);
    `);
    await expect(ingestRetrievalDocument(db, repositoryLink())).rejects.toThrow(/index row size/);
    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "010_retrieval_relations_long_facts.sql"),
      "utf8",
    );

    await db.exec(migration);

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'retrieval_relations' AND indexdef LIKE '%(source_chunk_id%'`,
    );
    expect(indexes.rows).toEqual([{ indexname: "retrieval_relations_source_chunk_idx" }]);
    await ingestRetrievalDocument(db, repositoryLink());
  });
});
