import { withClient } from "@doco/db";
import {
  type McpPrincipal,
  applyChangeset,
  createWorkspaceBrief,
  recordBriefFeedback,
  searchWorkspaceRecords,
} from "@doco/host";

type RpcId = string | number | null;

interface RpcMessage {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: unknown;
  params?: unknown;
}

const TOOLS = [
  {
    name: "list_workspaces",
    description: "List the one workspace this Doco deployment serves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "doco_brief",
    description:
      "Get binding rules, prior decisions, work in motion, and background before acting.",
    inputSchema: {
      type: "object",
      properties: {
        about: { type: "string", description: "What you are about to do." },
        touching: {
          type: "array",
          items: { type: "string" },
          description: "Files, URLs, record ids, or pull requests involved.",
        },
      },
      required: ["about"],
      additionalProperties: false,
    },
  },
  {
    name: "doco_get",
    description: "Read one workspace record by its full Doco id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "doco_search",
    description:
      "Search workspace records deterministically without a model or embedding provider.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "doco_changeset",
    description: "Apply one atomic, policy-checked changeset to a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection_handle: { type: "string" },
        operations: { type: "array", items: { type: "object" }, minItems: 1 },
        reason: { type: "string" },
      },
      required: ["collection_handle", "operations"],
      additionalProperties: false,
    },
  },
  {
    name: "doco_feedback",
    description: "Tell Doco whether a previous brief helped and, optionally, what was better.",
    inputSchema: {
      type: "object",
      properties: {
        result_id: { type: "string" },
        relevant: { type: "boolean" },
        better_answer_found: { type: "boolean" },
        better_answer: { type: "string" },
        better_answer_source: { type: "string" },
      },
      required: ["result_id", "relevant", "better_answer_found"],
      additionalProperties: false,
    },
  },
] as const;

export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function callTool(name: string, rawArguments: unknown, principal: McpPrincipal) {
  const args = object(rawArguments ?? {});
  if (name === "list_workspaces") {
    const workspace = await withClient(async (client) => {
      const found = await client.query(
        `SELECT w.id, w.handle, w.name, w.constitution, wu.role
           FROM workspaces w
           JOIN workspace_users wu ON wu.workspace_id = w.id
          WHERE w.id = $1 AND wu.user_id = $2`,
        [principal.workspaceId, principal.userId],
      );
      return found.rows[0] ?? null;
    });
    return toolResult(workspace ? [workspace] : []);
  }
  if (name === "doco_brief") {
    const touching = Array.isArray(args.touching)
      ? args.touching.filter((value): value is string => typeof value === "string")
      : [];
    const brief = await withClient((client) =>
      createWorkspaceBrief(client, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        about: string(args.about, "about"),
        touching,
      }),
    );
    return toolResult(brief);
  }
  if (name === "doco_get") {
    const record = await withClient(async (client) => {
      const found = await client.query(
        `SELECT n.id, c.handle AS collection_handle, n.node_type, n.lifecycle,
                n.prose, n.kind, n.locator, n.extra,
                n.created_at::text, n.updated_at::text
           FROM nodes n
           JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
          WHERE n.id = $1 AND c.workspace_id = $2
            AND EXISTS (
              SELECT 1 FROM workspace_users wu
               WHERE wu.workspace_id = c.workspace_id AND wu.user_id = $3
            )`,
        [string(args.id, "id"), principal.workspaceId, principal.userId],
      );
      return found.rows[0] ?? null;
    });
    if (!record) throw new Error("Record not found.");
    return toolResult(record);
  }
  if (name === "doco_search") {
    const query = string(args.query, "query");
    const requestedLimit = typeof args.limit === "number" ? args.limit : undefined;
    const results = await withClient(async (client) => {
      const searched = await searchWorkspaceRecords(client, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        query,
        ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
      });
      await client.query(
        `INSERT INTO query_events (actor, workspace_id, source, metadata)
         VALUES ($1, $2, 'mcp', $3::jsonb)`,
        [
          principal.userId,
          principal.workspaceId,
          JSON.stringify({ tool: "doco_search", query, result_ids: searched.map((row) => row.id) }),
        ],
      );
      return searched;
    });
    return toolResult({ query, results });
  }
  if (name === "doco_changeset") {
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
      throw new Error("operations must be a non-empty array.");
    }
    const result = await withClient((client) =>
      applyChangeset(client, {
        collectionHandle: string(args.collection_handle, "collection_handle"),
        actorId: principal.userId,
        operations: args.operations,
        source: "mcp",
        reason: typeof args.reason === "string" ? args.reason.trim() || null : null,
        metadata: { auth: "bearer", client: principal.label ?? "MCP client" },
      }),
    );
    return toolResult(result);
  }
  if (name === "doco_feedback") {
    await withClient((client) =>
      recordBriefFeedback(client, {
        resultId: string(args.result_id, "result_id"),
        userId: principal.userId,
        relevant: boolean(args.relevant, "relevant"),
        betterAnswerFound: boolean(args.better_answer_found, "better_answer_found"),
        betterAnswer: typeof args.better_answer === "string" ? args.better_answer : "",
        betterAnswerSource:
          typeof args.better_answer_source === "string" ? args.better_answer_source : "",
      }),
    );
    return toolResult({ ok: true });
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleMcpMessage(message: RpcMessage, principal: McpPrincipal) {
  const id = message.id ?? null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }
  if (message.id === undefined) return null;
  if (message.method === "initialize") {
    const params = object(message.params ?? {});
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Doco", version: process.env.DOCO_VERSION ?? "local" },
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (message.method === "tools/call") {
    try {
      const params = object(message.params);
      const name = string(params.name, "tool name");
      const result = await callTool(name, params.arguments, principal);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: error instanceof Error ? error.message : "Tool call failed." },
          ],
          isError: true,
        },
      };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}
