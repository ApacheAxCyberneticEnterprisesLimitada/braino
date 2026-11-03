import type { QueryClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  type CodeGraphClient,
  HttpCodeGraphClient,
  configuredCodeGraphClient,
  syncCodeGraphRepository,
} from "../code-graph-sync.js";

const COLLECTION_ID = "collection_code_graph";
const REPO = "acme/app";
let db: PGlite;

afterEach(() => vi.unstubAllGlobals());

const connected = JSON.stringify({
  template_handle: "codebase",
  github_integration: { connections: [{ repo: REPO, installation_id: 9 }] },
});

function graphClient(): CodeGraphClient & { createGraph: ReturnType<typeof vi.fn> } {
  return {
    id: "code-graph:test-v1",
    createGraph: vi.fn(async ({ language }) => ({
      stats: {
        language,
        source_files: 2,
        parsed_files: 2,
        parse_errors: 0,
        symbols: 2,
        edges: 1,
        build_ms: 1,
      },
      files: [
        { path: "app.py", symbols: [] },
        { path: "worker.py", symbols: ["run"] },
      ],
      edges: [
        {
          from: "app.py",
          to: "worker.py",
          type: "CALLS",
          label: "run",
          confidence: "exact",
        },
      ],
    })),
  };
}

beforeEach(async () => {
  db = await freshDb();
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_graph', 'graph', 'Graph')",
  );
  await db.query(
    `INSERT INTO collections (id, handle, owner_id, workspace_id, visibility, data)
     VALUES ($1, 'code-graph', 'workspace_graph', 'workspace_graph', 'private', $2)`,
    [COLLECTION_ID, connected],
  );
  await db.exec(`
    INSERT INTO code_files (collection_id, repo, path, sha, size, content) VALUES
      ('${COLLECTION_ID}', '${REPO}', 'app.py', 'sha_app_1', 35,
       'from worker import run\nrun()\n'),
      ('${COLLECTION_ID}', '${REPO}', 'worker.py', 'sha_worker_1', 24,
       'def run():\n    return 1\n'),
      ('${COLLECTION_ID}', '${REPO}', 'README.md', 'sha_readme_1', 8, '# App');
  `);
});

describe("code graph repository sync", () => {
  it("persists compiler-derived file relationships in the existing retrieval graph", async () => {
    const client = graphClient();

    const result = await syncCodeGraphRepository(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      repo: REPO,
      client,
    });

    expect(result).toEqual({ status: "indexed", files: 2, edges: 1 });
    expect(client.createGraph).toHaveBeenCalledWith({
      language: "python",
      files: [
        { path: "app.py", content: "from worker import run\nrun()\n" },
        { path: "worker.py", content: "def run():\n    return 1\n" },
      ],
    });
    expect(
      (
        await db.query<{ source: string; external_id: string; extraction_id: string }>(
          `SELECT source, external_id, extraction_id
             FROM retrieval_documents
            WHERE collection_id = $1 AND source = 'code_graph'`,
          [COLLECTION_ID],
        )
      ).rows,
    ).toEqual([{ source: "code_graph", external_id: REPO, extraction_id: "code-graph:test-v1" }]);
    expect(
      (
        await db.query<{ name: string; entity_type: string }>(
          `SELECT name, entity_type FROM retrieval_entities
            WHERE collection_id = $1 ORDER BY name`,
          [COLLECTION_ID],
        )
      ).rows,
    ).toEqual([
      { name: "acme/app/app.py", entity_type: "code_file" },
      { name: "acme/app/worker.py", entity_type: "code_file" },
    ]);
    expect(
      (
        await db.query<{ relation_type: string; fact: string; confidence: number }>(
          `SELECT relation_type, fact, confidence FROM retrieval_relations
            WHERE collection_id = $1`,
          [COLLECTION_ID],
        )
      ).rows,
    ).toEqual([
      {
        relation_type: "CALLS",
        fact: "acme/app/app.py CALLS acme/app/worker.py via run.",
        confidence: 1,
      },
    ]);
  });

  it("skips an unchanged repository and rebuilds after a file SHA changes", async () => {
    const client = graphClient();
    await syncCodeGraphRepository(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      repo: REPO,
      client,
    });

    expect(
      await syncCodeGraphRepository(db as unknown as QueryClient, {
        collectionId: COLLECTION_ID,
        repo: REPO,
        client,
      }),
    ).toEqual({ status: "unchanged", files: 2, edges: 1 });
    expect(client.createGraph).toHaveBeenCalledTimes(1);

    await db.exec(
      `UPDATE code_files SET sha = 'sha_app_2', content = 'from worker import run\nrun(); run()\n'
        WHERE collection_id = '${COLLECTION_ID}' AND repo = '${REPO}' AND path = 'app.py'`,
    );
    expect(
      await syncCodeGraphRepository(db as unknown as QueryClient, {
        collectionId: COLLECTION_ID,
        repo: REPO,
        client,
      }),
    ).toEqual({ status: "indexed", files: 2, edges: 1 });
    expect(client.createGraph).toHaveBeenCalledTimes(2);
  });

  it("removes the derived graph when no supported source files remain", async () => {
    const client = graphClient();
    await syncCodeGraphRepository(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      repo: REPO,
      client,
    });
    await db.exec(
      `DELETE FROM code_files
        WHERE collection_id = '${COLLECTION_ID}' AND repo = '${REPO}' AND path LIKE '%.py'`,
    );

    expect(
      await syncCodeGraphRepository(db as unknown as QueryClient, {
        collectionId: COLLECTION_ID,
        repo: REPO,
        client,
      }),
    ).toEqual({ status: "deleted", files: 0, edges: 0 });
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM retrieval_documents WHERE collection_id = $1",
          [COLLECTION_ID],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM retrieval_entities WHERE collection_id = $1",
          [COLLECTION_ID],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("deletes the derived graph when its repository disconnects", async () => {
    await syncCodeGraphRepository(db as unknown as QueryClient, {
      collectionId: COLLECTION_ID,
      repo: REPO,
      client: graphClient(),
    });

    await db.exec(
      `UPDATE collections
          SET data = '{"template_handle":"codebase","github_integration":{"connections":[]}}'
        WHERE id = '${COLLECTION_ID}'`,
    );

    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM retrieval_documents WHERE collection_id = $1",
          [COLLECTION_ID],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM retrieval_entities WHERE collection_id = $1",
          [COLLECTION_ID],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });
});

describe("configured code graph client", () => {
  it("is optional but rejects half-configured service credentials", () => {
    expect(configuredCodeGraphClient({})).toBeNull();
    expect(() =>
      configuredCodeGraphClient({ DOCO_CODE_GRAPH_URL: "https://graph.example" }),
    ).toThrow(/DOCO_CODE_GRAPH_API_TOKEN/);
    expect(() => configuredCodeGraphClient({ DOCO_CODE_GRAPH_API_TOKEN: "secret" })).toThrow(
      /DOCO_CODE_GRAPH_URL/,
    );
  });

  it("sends authenticated snapshots and rejects edges outside the submitted repository", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        stats: {
          language: "python",
          source_files: 1,
          parsed_files: 1,
          parse_errors: 0,
          symbols: 0,
          edges: 1,
          build_ms: 1,
        },
        files: [{ path: "app.py", symbols: [] }],
        edges: [
          {
            from: "app.py",
            to: "missing.py",
            type: "IMPORTS",
            label: "missing",
            confidence: "exact",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new HttpCodeGraphClient({
      url: "https://graph.example/",
      apiToken: "test-token",
    });

    await expect(
      client.createGraph({
        language: "python",
        files: [{ path: "app.py", content: "print('hello')" }],
      }),
    ).rejects.toThrow(/unknown file/i);
    expect(fetch).toHaveBeenCalledWith(
      "https://graph.example/v1/graphs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-token" }),
      }),
    );
  });
});
