import type { PoolClient } from "@doco/db";
import type { CodeGraphClient } from "@doco/index";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  connectGithubRepository,
  listGithubConnections,
  syncGithubConnection,
} from "../github-connections.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
let activeScopes = 0;
const scope = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
  activeScopes += 1;
  try {
    return await operation(client());
  } finally {
    activeScopes -= 1;
  }
};
function recordingClient(statements: string[]): PoolClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return db.query(sql, params);
    },
  } as unknown as PoolClient;
}
const recordingScope = (statements: string[]) =>
  (<T>(operation: (client: PoolClient) => Promise<T>) =>
    operation(recordingClient(statements))) as typeof scope;
const encryptionKey = "github-connection-test-key-with-more-than-thirty-two-characters";
const accessToken = "github_pat_test-only-never-store-plaintext";

async function fixture() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

interface GithubState {
  issueState: "open" | "closed";
  pullState: "open" | "closed";
  mergedAt: string | null;
}

function fakeGithub(state: GithubState): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    expect(activeScopes).toBe(0);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
    if (url === "https://api.github.com/repos/acme/widgets") {
      return Response.json({ full_name: "acme/widgets", default_branch: "main" });
    }
    if (url === "https://api.github.com/repos/acme/widgets/git/trees/main?recursive=1") {
      return Response.json({
        truncated: false,
        tree: [{ path: "app.py", type: "blob", sha: "code-sha", size: 24 }],
      });
    }
    if (url === "https://api.github.com/repos/acme/widgets/git/blobs/code-sha") {
      return Response.json({
        encoding: "base64",
        content: Buffer.from("from worker import run\nrun()\n").toString("base64"),
      });
    }
    if (url.includes("/issues?")) {
      return Response.json([
        {
          number: 17,
          title: "Document retry behavior",
          body: "Make retries explicit for operators.",
          html_url: "https://github.com/acme/widgets/issues/17",
          state: state.issueState,
          created_at: "2026-11-01T10:00:00Z",
          updated_at: state.issueState === "open" ? "2026-11-01T10:00:00Z" : "2026-11-02T10:00:00Z",
          user: { login: "octo" },
          labels: [{ name: "documentation" }],
          comments: 2,
          locked: false,
        },
        {
          number: 23,
          title: "This is a pull request, not an issue",
          pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/23" },
        },
      ]);
    }
    if (url.includes("/pulls?")) {
      return Response.json([
        {
          number: 23,
          title: "Keep webhook deliveries idempotent",
          body: "Adds a delivery ledger.",
          html_url: "https://github.com/acme/widgets/pull/23",
          state: state.pullState,
          draft: false,
          merged_at: state.mergedAt,
          created_at: "2026-11-01T11:00:00Z",
          updated_at: state.mergedAt ?? "2026-11-01T11:00:00Z",
          user: { login: "octo" },
          labels: [{ name: "integration" }],
          head: { ref: "webhooks" },
          base: { ref: "main" },
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("self-hosted GitHub connections", () => {
  it("encrypts the token and idempotently imports issues and pull requests with history", async () => {
    const setup = await fixture();
    const state: GithubState = { issueState: "open", pullState: "open", mergedAt: null };
    const connection = await connectGithubRepository(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      repository: "acme/widgets",
      accessToken,
      encryptionKey,
      fetcher: fakeGithub(state),
    });

    expect(connection.repository).toBe("acme/widgets");
    expect(connection.issuesCollectionHandle).toBe("acme-github-issues");
    expect(connection.pullRequestsCollectionHandle).toBe("acme-github-pull-requests");
    expect(connection.codeCollectionHandle).toBe("acme-codebase");
    const stored = await db.query<{ token_sealed: string }>(
      "SELECT token_sealed FROM github_connections WHERE id = $1",
      [connection.id],
    );
    expect(stored.rows[0]?.token_sealed).not.toContain(accessToken);
    expect(await listGithubConnections(client(), setup.workspace.id, setup.owner.id)).toEqual([
      expect.objectContaining({ id: connection.id, repository: "acme/widgets" }),
    ]);

    const statements: string[] = [];
    const codeGraphClient: CodeGraphClient = {
      id: "codelinker:test-v1",
      createGraph: async (input) => ({
        stats: {
          language: input.language,
          source_files: input.files.length,
          parsed_files: input.files.length,
          parse_errors: 0,
          symbols: 0,
          edges: 0,
          build_ms: 1,
        },
        files: input.files.map((file) => ({ path: file.path, symbols: [] })),
        edges: [],
      }),
      createRepositoryLinks: async (input) => ({
        stats: {
          repositories: input.repositories.length,
          source_files: input.repositories.flatMap((repository) => repository.files).length,
          links: 0,
          build_ms: 1,
        },
        links: [],
      }),
    };
    const first = await syncGithubConnection(recordingScope(statements), {
      connectionId: connection.id,
      encryptionKey,
      fetcher: fakeGithub(state),
      codeGraphClient,
    });
    expect(first).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const transaction = statements.findIndex((sql) => sql === "BEGIN");
    const connectionLock = statements.findIndex((sql) =>
      /SELECT \* FROM github_connections WHERE id = \$1 FOR UPDATE/.test(sql),
    );
    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(connectionLock).toBeGreaterThan(transaction);
    const githubLocatorIndex = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'nodes_github_locator_unique_idx'",
    );
    expect(githubLocatorIndex.rows[0]?.indexdef).toContain("UNIQUE INDEX");
    const nodes = await db.query<{
      node_type: string;
      lifecycle: string;
      locator: string;
      extra: Record<string, unknown>;
    }>("SELECT node_type, lifecycle, locator, extra FROM nodes ORDER BY locator");
    expect(nodes.rows).toEqual([
      expect.objectContaining({
        node_type: "eval",
        lifecycle: "active",
        locator: "https://github.com/acme/widgets/issues/17",
      }),
      expect.objectContaining({
        node_type: "reference",
        lifecycle: "drafting",
        locator: "https://github.com/acme/widgets/pull/23",
      }),
    ]);
    expect(nodes.rows[0]?.extra.github_repository).toBe("acme/widgets");
    expect(
      (
        await db.query<{ repo: string; path: string; content: string }>(
          "SELECT repo, path, content FROM code_files",
        )
      ).rows,
    ).toEqual([
      {
        repo: "acme/widgets",
        path: "app.py",
        content: "from worker import run\nrun()\n",
      },
    ]);
    expect(
      (
        await db.query<{ source: string }>(
          "SELECT source FROM retrieval_documents WHERE source = 'code_graph'",
        )
      ).rows,
    ).toHaveLength(1);

    const replay = await syncGithubConnection(scope, {
      connectionId: connection.id,
      encryptionKey,
      fetcher: fakeGithub(state),
      codeGraphClient,
    });
    expect(replay).toEqual({ created: 0, updated: 0, unchanged: 2 });
    const unchangedCounts = await db.query<{
      versions: number;
      changesets: number;
      audits: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM node_versions) AS versions,
         (SELECT count(*)::int FROM changesets) AS changesets,
         (SELECT count(*)::int FROM audit_events) AS audits`,
    );
    expect(unchangedCounts.rows[0]).toEqual({ versions: 2, changesets: 2, audits: 2 });

    state.issueState = "closed";
    state.pullState = "closed";
    state.mergedAt = "2026-11-03T12:00:00Z";
    const changed = await syncGithubConnection(scope, {
      connectionId: connection.id,
      encryptionKey,
      fetcher: fakeGithub(state),
      codeGraphClient,
    });
    expect(changed).toEqual({ created: 0, updated: 2, unchanged: 0 });
    const lifecycles = await db.query<{ lifecycle: string }>(
      "SELECT lifecycle FROM nodes ORDER BY locator",
    );
    expect(lifecycles.rows).toEqual([{ lifecycle: "retired" }, { lifecycle: "active" }]);
    const changedCounts = await db.query<{ versions: number; changesets: number; audits: number }>(
      `SELECT
         (SELECT count(*)::int FROM node_versions) AS versions,
         (SELECT count(*)::int FROM changesets) AS changesets,
         (SELECT count(*)::int FROM audit_events) AS audits`,
    );
    expect(changedCounts.rows[0]).toEqual({ versions: 4, changesets: 4, audits: 4 });
  });

  it("requires a workspace owner", async () => {
    const setup = await fixture();
    await db.query(
      `INSERT INTO users (id, username, name, email, password_hash, data)
       VALUES ('user_writer', 'writer', 'Writer', 'writer@example.com', 'hash', '{}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role)
       VALUES ($1, 'user_writer', 'writer')`,
      [setup.workspace.id],
    );
    await expect(
      connectGithubRepository(scope, {
        workspaceId: setup.workspace.id,
        userId: "user_writer",
        repository: "acme/widgets",
        accessToken,
        encryptionKey,
        fetcher: fakeGithub({ issueState: "open", pullState: "open", mergedAt: null }),
      }),
    ).rejects.toMatchObject({ code: "owner_required", status: 403 });
  });

  it("rejects overlapping syncs and releases a failed sync lease", async () => {
    const setup = await fixture();
    const state: GithubState = { issueState: "open", pullState: "open", mergedAt: null };
    const connection = await connectGithubRepository(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      repository: "acme/widgets",
      accessToken,
      encryptionKey,
      fetcher: fakeGithub(state),
    });
    await db.query(
      "UPDATE github_connections SET sync_token = 'held', sync_started_at = now() WHERE id = $1",
      [connection.id],
    );
    await expect(
      syncGithubConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        fetcher: fakeGithub(state),
      }),
    ).rejects.toMatchObject({ code: "sync_in_progress", status: 409 });

    await db.query(
      "UPDATE github_connections SET sync_token = NULL, sync_started_at = NULL WHERE id = $1",
      [connection.id],
    );
    const oversized = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(activeScopes).toBe(0);
      if (url.includes("/issues?")) {
        return Response.json(Array.from({ length: 10_001 }, (_, number) => ({ number })));
      }
      if (url.includes("/pulls?")) return Response.json([]);
      return fakeGithub(state)(input, init);
    }) as typeof fetch;
    await expect(
      syncGithubConnection(scope, {
        connectionId: connection.id,
        encryptionKey,
        fetcher: oversized,
      }),
    ).rejects.toMatchObject({ code: "github_too_large", status: 422 });
    expect(
      (
        await db.query<{ sync_token: string | null; last_error: string | null }>(
          "SELECT sync_token, last_error FROM github_connections WHERE id = $1",
          [connection.id],
        )
      ).rows[0],
    ).toMatchObject({ sync_token: null, last_error: expect.stringContaining("10,000") });
  });
});
