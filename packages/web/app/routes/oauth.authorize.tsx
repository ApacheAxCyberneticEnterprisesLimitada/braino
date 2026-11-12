import { withClient } from "@doco/db";
import {
  MCP_OAUTH_SCOPE,
  McpOauthError,
  getMcpOauthClient,
  getSingleWorkspaceState,
  issueMcpOauthAuthorizationCode,
} from "@doco/host";
import { Form, Link, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { NarrowPageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { mcpResource, publicOrigin } from "~/lib/public-origin.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  state: string | null;
}

function params(request: Request): AuthorizeParams {
  const url = new URL(request.url);
  return {
    responseType: url.searchParams.get("response_type") ?? "",
    clientId: url.searchParams.get("client_id") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
    scope: url.searchParams.get("scope") ?? "",
    resource: url.searchParams.get("resource") ?? "",
    state: url.searchParams.get("state"),
  };
}

function invalid(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function validate(request: Request, input: AuthorizeParams): void {
  if (input.responseType !== "code") throw invalid("response_type must be 'code'");
  if (!input.clientId) throw invalid("client_id is required");
  if (!input.redirectUri) throw invalid("redirect_uri is required");
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw invalid("code_challenge must be PKCE S256");
  }
  if (input.codeChallengeMethod !== "S256") throw invalid("code_challenge_method must be 'S256'");
  if (input.scope !== MCP_OAUTH_SCOPE) throw invalid(`scope must be '${MCP_OAUTH_SCOPE}'`);
  if (input.resource !== mcpResource(request))
    throw invalid("resource must be this instance's /mcp URL");
}

async function loadClient(input: AuthorizeParams) {
  const oauthClient = await withClient((client) => getMcpOauthClient(client, input.clientId));
  if (!oauthClient) throw invalid("invalid_client: unknown client_id");
  if (!oauthClient.redirectUris.includes(input.redirectUri)) {
    throw invalid("invalid_redirect_uri: redirect_uri is not registered");
  }
  return oauthClient;
}

function clientRedirect(
  request: Request,
  input: AuthorizeParams,
  values: Record<string, string>,
): Response {
  const target = new URL(input.redirectUri);
  for (const [name, value] of Object.entries(values)) target.searchParams.set(name, value);
  if (input.state) target.searchParams.set("state", input.state);
  target.searchParams.set("iss", publicOrigin(request));
  return redirect(target.toString());
}

export async function loader({ request }: { request: Request }) {
  const input = params(request);
  validate(request, input);
  const oauthClient = await loadClient(input);
  const user = await getCurrentUser(request);
  if (!user) {
    const url = new URL(request.url);
    throw redirect(`/?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw invalid("Finish Braino setup before connecting an agent.", 409);
  return {
    clientName: oauthClient.clientName,
    workspace: state.workspace,
    instance: publicOrigin(request),
    authorizePath: `${new URL(request.url).pathname}${new URL(request.url).search}`,
  };
}

export async function action({ request }: { request: Request }) {
  const input = params(request);
  validate(request, input);
  await loadClient(input);
  const user = await getCurrentUser(request);
  if (!user) throw invalid("Sign in before approving this connection.", 401);
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw invalid("Finish Braino setup before connecting an agent.", 409);
  try {
    const form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
    if (form.get("decision") !== "allow") {
      return clientRedirect(request, input, {
        error: "access_denied",
        error_description: "The user declined this Braino connection.",
      });
    }
    const issued = await withClient((client) =>
      issueMcpOauthAuthorizationCode(client, {
        clientId: input.clientId,
        userId: user.id,
        workspaceId: state.workspace.id,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        scope: input.scope,
        resource: input.resource,
      }),
    );
    return clientRedirect(request, input, { code: issued.code });
  } catch (caught) {
    if (caught instanceof RequestBodyError) throw invalid(caught.message, caught.status);
    if (caught instanceof McpOauthError) throw invalid(`${caught.code}: ${caught.message}`);
    throw caught;
  }
}

export function meta() {
  return [{ title: "Connect an agent · Braino" }];
}

export default function AuthorizePage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  return (
    <NarrowPageMain className="space-y-4 py-10">
      <nav className="font-mono text-[11px] text-muted-foreground">
        <Link to="/">Braino</Link> <span aria-hidden>›</span> Connect an agent
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>Connect {data.clientName}</CardTitle>
          <CardDescription>
            Allow this client to use the {data.workspace.name} workspace on this Braino instance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            The connection uses your live workspace role. Its OAuth credentials, requests, and
            records stay on <span className="font-mono">{data.instance}</span>; Braino production is
            not in the path.
          </p>
          <Form method="post" action={data.authorizePath} className="mt-4 flex gap-2">
            <button
              type="submit"
              name="decision"
              value="allow"
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              Allow
            </button>
            <button
              type="submit"
              name="decision"
              value="deny"
              className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </Form>
        </CardContent>
      </Card>
    </NarrowPageMain>
  );
}
