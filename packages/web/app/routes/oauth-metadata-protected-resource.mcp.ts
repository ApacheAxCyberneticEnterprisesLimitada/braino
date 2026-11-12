import { MCP_OAUTH_SCOPE } from "@doco/host";
import { mcpResource, publicOrigin } from "~/lib/public-origin.server";

export function loader({ request }: { request: Request }) {
  const issuer = publicOrigin(request);
  return Response.json(
    {
      resource: mcpResource(request),
      authorization_servers: [issuer],
      scopes_supported: [MCP_OAUTH_SCOPE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${issuer}/mcp-tokens`,
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
