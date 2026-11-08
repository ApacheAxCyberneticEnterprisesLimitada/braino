import { withClient } from "@doco/db";
import {
  createIncomingWebhook,
  getSingleWorkspaceState,
  listIncomingWebhooks,
  revokeIncomingWebhook,
} from "@doco/host";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";

interface ActionData {
  webhookUrl?: string;
  error?: string;
}

export function meta() {
  return [{ title: "Integrations · Doco" }];
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const loaded = await withClient(async (client) => {
    const membership = await client.query<{ role: string }>(
      "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [state.workspace.id, user.id],
    );
    if (membership.rows[0]?.role !== "owner")
      throw new Response("Owner access required", { status: 403 });
    const collections = await client.query<{ id: string; handle: string }>(
      `SELECT id, handle FROM collections
        WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY handle`,
      [state.workspace.id],
    );
    return {
      collections: collections.rows,
      webhooks: await listIncomingWebhooks(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
      }),
    };
  });
  const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
  return { workspace: state.workspace, publicHost, ...loaded };
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
  if (intent === "create_webhook") {
    try {
      const created = await withClient((client) =>
        createIncomingWebhook(client, {
          workspaceId: state.workspace.id,
          collectionId: text(form, "collection_id"),
          userId: user.id,
          label: text(form, "label"),
        }),
      );
      const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
        /\/$/,
        "",
      );
      return { webhookUrl: `${publicHost}/api/v1/webhooks/${created.accessToken}` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not create webhook." };
    }
  }
  if (intent === "revoke_webhook") {
    await withClient((client) =>
      revokeIncomingWebhook(client, { tokenId: text(form, "token_id"), userId: user.id }),
    );
    return redirect("/integrations");
  }
  return Response.json({ error: "Unknown integration action." }, { status: 400 });
}

export default function IntegrationsPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as ActionData | undefined;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              Doco
            </Link>
            <span aria-hidden>›</span>
            <span>{data.workspace.handle}</span>
            <span aria-hidden>›</span>
            <span>Integrations</span>
          </nav>
        }
        title="Integrations"
      >
        <p className="text-xs text-muted-foreground">
          Bring external systems into Doco through retry-safe, policy-checked changesets.
        </p>
      </PageHeader>

      {actionData?.webhookUrl ? (
        <Card>
          <CardHeader>
            <CardTitle>Copy this webhook URL now</CardTitle>
            <CardDescription>
              The secret URL is shown once. Send JSON changesets with a unique Idempotency-Key
              header.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <textarea
              readOnly
              rows={3}
              value={actionData.webhookUrl}
              aria-label="Incoming webhook URL"
              className="w-full rounded-md px-3 py-2 font-mono text-xs"
            />
          </CardContent>
        </Card>
      ) : null}
      {actionData?.error ? <p className="text-sm text-destructive">{actionData.error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>New incoming webhook</CardTitle>
          <CardDescription>
            Choose its destination. Every delivery uses that collection&apos;s authoring policies
            and immutable history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intent" value="create_webhook" />
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Name</span>
              <input
                name="label"
                required
                maxLength={100}
                className="w-full rounded-md px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">Collection</span>
              <select name="collection_id" className="w-full rounded-md px-3 py-2 text-sm">
                {data.collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.handle}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2 sm:text-right">
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                Create webhook
              </button>
            </div>
          </Form>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Incoming webhooks</h2>
        {data.webhooks.length ? (
          data.webhooks.map((webhook) => (
            <Card key={webhook.tokenId}>
              <CardContent className="flex flex-wrap items-center gap-3 pt-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{webhook.label}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {webhook.collectionHandle} ·{" "}
                    {webhook.revoked
                      ? "revoked"
                      : webhook.lastUsedAt
                        ? `last used ${new Date(webhook.lastUsedAt).toLocaleString()}`
                        : "never used"}
                  </p>
                </div>
                {!webhook.revoked ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="revoke_webhook" />
                    <input type="hidden" name="token_id" value={webhook.tokenId} />
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
          <p className="text-sm italic text-muted-foreground">No incoming webhooks yet.</p>
        )}
      </section>
    </PageMain>
  );
}
