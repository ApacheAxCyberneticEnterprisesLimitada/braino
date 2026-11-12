import { MCP_OAUTH_SCOPE } from "@doco/host";
import { publicOrigin } from "~/lib/public-origin.server";

export function loader({ request }: { request: Request }) {
  const issuer = publicOrigin(request);
  return Response.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [MCP_OAUTH_SCOPE],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${issuer}/mcp-tokens`,
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
