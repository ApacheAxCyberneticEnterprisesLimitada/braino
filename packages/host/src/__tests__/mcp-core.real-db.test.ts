import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { applyChangeset } from "../changesets.js";
import {
  authenticateMcpToken,
  createMcpToken,
  createWorkspaceBrief,
  recordBriefFeedback,
  revokeMcpToken,
} from "../mcp-core.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const written = await applyChangeset(client(), {
    collectionHandle: "acme-product-decisions",
    actorId: setup.owner.id,
    source: "mcp",
    operations: [
      {
        op: "create",
        node_type: "decision",
        body: {
          lifecycle: "drafting",
          prose:
            "Keep recoverable PostgreSQL backups\nCreate a daily custom-format dump before upgrades.",
        },
      },
      {
        op: "create",
        node_type: "rule",
        body: {
          lifecycle: "drafting",
          prose:
            "Recovery drills must use a clean database\nNever validate restore over production data.",
        },
      },
    ],
  });
  return { setup, written };
}

describe("self-hosted MCP core", () => {
  it("mints a hashed workspace token, authenticates it, and revokes it", async () => {
    const { setup } = await fixture();

    const token = await createMcpToken(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      label: "Claude Code",
    });

    expect(token.accessToken).toMatch(/^doco_at_/);
    expect(await authenticateMcpToken(client(), token.accessToken)).toMatchObject({
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      role: "owner",
      label: "Claude Code",
    });
    const stored = await db.query<{ token: string }>(
      "SELECT token FROM oauth_access_tokens WHERE user_id = $1",
      [setup.owner.id],
    );
    expect(stored.rows[0]?.token).not.toBe(token.accessToken);

    await revokeMcpToken(client(), { tokenId: token.tokenId, userId: setup.owner.id });
    await expect(authenticateMcpToken(client(), token.accessToken)).resolves.toBeNull();
  });

  it("builds a deterministic brief and records its feedback without a model", async () => {
    const { setup, written } = await fixture();

    const brief = await createWorkspaceBrief(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      agentLabel: "Claude Code",
      about: "backup recovery",
      touching: ["PostgreSQL"],
    });

    expect(brief.result_id).toMatch(/^result_/);
    expect(brief.brief_id).toMatch(/^brief_/);
    expect(brief.decided).toEqual([
      expect.objectContaining({ id: written.results[0]?.id, node_type: "decision" }),
    ]);
    expect(brief.must_obey).toEqual([
      expect.objectContaining({ id: written.results[1]?.id, node_type: "rule" }),
    ]);
    expect(brief.model).toBe("none");
    const activity = await db.query<{ source: string; metadata: Record<string, unknown> }>(
      "SELECT source, metadata FROM query_events WHERE metadata ? 'brief_id'",
    );
    expect(activity.rows[0]).toEqual({
      source: "mcp",
      metadata: expect.objectContaining({ auth: "bearer", client: "Claude Code" }),
    });

    await recordBriefFeedback(client(), {
      resultId: brief.result_id,
      userId: setup.owner.id,
      relevant: true,
      betterAnswerFound: false,
    });
    const feedback = await db.query<{ relevant: boolean; feedback_at: Date | string }>(
      "SELECT relevant, feedback_at FROM agent_results WHERE id = $1",
      [brief.result_id],
    );
    expect(feedback.rows[0]?.relevant).toBe(true);
    expect(feedback.rows[0]?.feedback_at).toBeTruthy();
  });
});
