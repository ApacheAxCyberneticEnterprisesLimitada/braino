import { withClient } from "@doco/db";
import { McpOauthError, registerMcpOauthClient } from "@doco/host";
import { MAX_FORM_BODY_BYTES, RequestBodyError, readBoundedJson } from "~/lib/request-body.server";

function error(code: string, description: string, status = 400) {
  return Response.json(
    { error: code, error_description: description },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") return error("invalid_request", "POST required", 405);
  try {
    const body = (await readBoundedJson(request, MAX_FORM_BODY_BYTES)) as Record<string, unknown>;
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.every((uri) => typeof uri === "string")) {
      return error("invalid_redirect_uri", "redirect_uris must be an array of strings");
    }
    if (
      body.token_endpoint_auth_method !== undefined &&
      body.token_endpoint_auth_method !== "none"
    ) {
      return error("invalid_client_metadata", "only public clients with auth method 'none' work");
    }
    const created = await withClient((client) =>
      registerMcpOauthClient(client, {
        clientName: typeof body.client_name === "string" ? body.client_name : undefined,
        redirectUris,
      }),
    );
    return Response.json(
      {
        client_id: created.clientId,
        client_id_issued_at: Math.floor(new Date(created.registeredAt).getTime() / 1000),
        client_name: created.clientName,
        redirect_uris: created.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (caught) {
    if (caught instanceof RequestBodyError)
      return error("invalid_request", caught.message, caught.status);
    if (caught instanceof McpOauthError) return error(caught.code, caught.message);
    throw caught;
  }
}

export function loader() {
  return error("invalid_request", "POST required", 405);
}
