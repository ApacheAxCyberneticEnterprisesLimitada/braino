import { withClient } from "@doco/db";
import { authenticateMcpToken } from "@doco/host";
import { handleMcpMessage } from "~/lib/mcp-server";
import { MAX_JSON_BODY_BYTES, RequestBodyError, readBoundedJson } from "~/lib/request-body.server";

const jsonHeaders = { "Content-Type": "application/json" };

export function loader() {
  return Response.json(
    { error: "Braino MCP uses stateless JSON-RPC over POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

function bearer(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405, headers: { Allow: "POST" } });
  }
  const token = bearer(request);
  const principal = token
    ? await withClient((client) => authenticateMcpToken(client, token))
    : null;
  if (!principal) {
    return Response.json(
      { error: "A valid Braino MCP bearer token is required." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="Braino MCP"' } },
    );
  }
  let message: unknown;
  try {
    message = await readBoundedJson(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof RequestBodyError ? error.message : "Parse error",
        },
      }),
      { status: error instanceof RequestBodyError ? error.status : 400, headers: jsonHeaders },
    );
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      }),
      { status: 400, headers: jsonHeaders },
    );
  }
  const response = await handleMcpMessage(message, principal);
  if (!response) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(response), { headers: jsonHeaders });
}
