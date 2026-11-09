import { withClient } from "@doco/db";
import { createMcpToken, getSingleWorkspaceState, listMcpTokens, revokeMcpToken } from "@doco/host";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";

interface ActionData {
  accessToken?: string;
  expiresAt?: string;
  error?: string;
}

export function meta() {
  return [{ title: "MCP connections · Braino" }];
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const tokens = await withClient((client) =>
    listMcpTokens(client, { workspaceId: state.workspace.id, userId: user.id }),
  );
  const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
  return { workspace: state.workspace, tokens, endpoint: `${publicHost}/mcp` };
}

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function action({ request }: { request: Request }): Promise<ActionData | Response> {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
  const form = await request.formData();
  const intent = text(form, "intent");
  if (intent === "create") {
    const created = await withClient((client) =>
      createMcpToken(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        label: text(form, "label"),
      }),
    );
    return { accessToken: created.accessToken, expiresAt: created.expiresAt };
  }
  if (intent === "revoke") {
    await withClient((client) =>
      revokeMcpToken(client, { tokenId: text(form, "token_id"), userId: user.id }),
    );
    return redirect("/mcp-tokens");
  }
  return Response.json({ error: "Unknown MCP token action." }, { status: 400 });
}

export default function McpTokensPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as ActionData | undefined;
  const config = actionData?.accessToken
    ? JSON.stringify(
        {
          mcpServers: {
            doco: {
              url: data.endpoint,
              headers: { Authorization: `Bearer ${actionData.accessToken}` },
            },
          },
        },
        null,
        2,
      )
    : null;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              Braino
            </Link>
            <span aria-hidden>›</span>
            <span>{data.workspace.handle}</span>
            <span aria-hidden>›</span>
            <span>MCP connections</span>
          </nav>
        }
        title="MCP connections"
      >
        <p className="text-xs text-muted-foreground">
          Connect an agent to briefs, records, feedback, and atomic authoring in this workspace.
        </p>
      </PageHeader>

      {config ? (
        <Card>
          <CardHeader>
            <CardTitle>Copy this connection now</CardTitle>
            <CardDescription>
              The token is shown once. Store it as a secret; revoke it here if it is exposed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <textarea
              readOnly
              rows={10}
              value={config}
              aria-label="MCP client configuration"
              className="w-full rounded-md px-3 py-2 font-mono text-xs"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Expires {new Date(actionData?.expiresAt ?? "").toLocaleDateString()}.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>New connection</CardTitle>
          <CardDescription>
            Tokens inherit your live workspace access and stop working if your membership is
            removed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="intent" value="create" />
            <label className="min-w-0 flex-1 text-xs">
              <span className="mb-1 block text-muted-foreground">Connection name</span>
              <input
                name="label"
                required
                maxLength={100}
                placeholder="Claude Code on my laptop"
                className="w-full rounded-md px-3 py-2 text-sm"
              />
            </label>
            <button
              type="submit"
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              Create token
            </button>
          </Form>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Existing connections</h2>
        {data.tokens.length ? (
          data.tokens.map((token) => (
            <Card key={token.tokenId}>
              <CardContent className="flex flex-wrap items-center gap-3 pt-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{token.label ?? "MCP client"}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {token.revoked
                      ? "Revoked"
                      : token.lastUsedAt
                        ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                        : "Never used"}
                  </p>
                </div>
                {!token.revoked ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="revoke" />
                    <input type="hidden" name="token_id" value={token.tokenId} />
                    <button
                      type="submit"
                      className="neu-button rounded-md px-3 py-2 text-xs font-semibold text-destructive"
                    >
                      Revoke
                    </button>
                  </Form>
                ) : null}
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="text-sm italic text-muted-foreground">No MCP connections yet.</p>
        )}
      </section>
    </PageMain>
  );
}
