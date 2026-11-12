import { withClient } from "@doco/db";
import {
  McpOauthError,
  exchangeMcpOauthAuthorizationCode,
  refreshMcpOauthTokens,
} from "@doco/host";
import { mcpResource } from "~/lib/public-origin.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

function value(form: FormData, name: string): string {
  const found = form.get(name);
  if (typeof found !== "string" || !found) {
    throw new McpOauthError("invalid_request", `${name} is required`);
  }
  return found;
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

function oauthError(code: string, description: string, status = 400) {
  return response({ error: code, error_description: description }, status);
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  try {
    const form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
    const grantType = value(form, "grant_type");
    const clientId = value(form, "client_id");
    const resource = value(form, "resource");
    if (resource !== mcpResource(request)) {
      throw new McpOauthError("invalid_target", "resource must be this instance's /mcp URL");
    }
    if (grantType === "authorization_code") {
      return response(
        await withClient((client) =>
          exchangeMcpOauthAuthorizationCode(client, {
            clientId,
            code: value(form, "code"),
            redirectUri: value(form, "redirect_uri"),
            codeVerifier: value(form, "code_verifier"),
            resource,
          }),
        ),
      );
    }
    if (grantType === "refresh_token") {
      return response(
        await withClient((client) =>
          refreshMcpOauthTokens(client, {
            clientId,
            refreshToken: value(form, "refresh_token"),
            resource,
          }),
        ),
      );
    }
    return oauthError("unsupported_grant_type", "grant_type is not supported");
  } catch (caught) {
    if (caught instanceof RequestBodyError) {
      return oauthError("invalid_request", caught.message, caught.status);
    }
    if (caught instanceof McpOauthError) {
      return oauthError(caught.code, caught.message, caught.code === "invalid_client" ? 401 : 400);
    }
    throw caught;
  }
}

export function loader() {
  return oauthError("invalid_request", "POST required", 405);
}
