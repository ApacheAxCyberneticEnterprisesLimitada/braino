import { withClient } from "@doco/db";
import {
  type ConnectorConnectionSummary,
  type GithubConnectionSummary,
  connectConnector,
  connectGithubRepository,
  createIncomingWebhook,
  disconnectConnector,
  disconnectGithubRepository,
  getSingleWorkspaceState,
  listConnectorConnections,
  listGithubConnections,
  listIncomingWebhooks,
  revokeIncomingWebhook,
  slackConnector,
  syncConnectorConnection,
  syncGithubConnection,
} from "@doco/host";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";

interface ActionData {
  webhookUrl?: string;
  message?: string;
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
    if (membership.rows[0]?.role !== "owner") {
      throw new Response("Owner access required", { status: 403 });
    }
    const collections = await client.query<{ id: string; handle: string }>(
      `SELECT id, handle FROM collections
        WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY handle`,
      [state.workspace.id],
    );
    return {
      collections: collections.rows,
      connectorConnections: await listConnectorConnections(client, state.workspace.id, user.id),
      githubConnections: await listGithubConnections(client, state.workspace.id, user.id),
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

function encryptionKey(): string {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return value;
}

export async function action({ request }: { request: Request }): Promise<ActionData | Response> {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
  const form = await request.formData();
  const intent = text(form, "intent");

  if (intent === "connect_slack") {
    try {
      const connected = await withClient((client) =>
        connectConnector(client, {
          workspaceId: state.workspace.id,
          userId: user.id,
          credential: text(form, "bot_token"),
          encryptionKey: encryptionKey(),
          adapter: slackConnector,
        }),
      );
      const synced = await withClient((client) =>
        syncConnectorConnection(client, {
          connectionId: connected.id,
          encryptionKey: encryptionKey(),
          userId: user.id,
          adapter: slackConnector,
        }),
      );
      return {
        message: `Connected ${connected.sourceName}. Imported ${synced.created} Slack messages.`,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not connect Slack." };
    }
  }

  if (intent === "sync_connector") {
    try {
      const synced = await withClient((client) =>
        syncConnectorConnection(client, {
          connectionId: text(form, "connection_id"),
          encryptionKey: encryptionKey(),
          userId: user.id,
          adapter: slackConnector,
        }),
      );
      return {
        message: `Slack sync complete: ${synced.created} created, ${synced.updated} updated, ${synced.retired} retired, ${synced.unchanged} unchanged.`,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not sync Slack." };
    }
  }

  if (intent === "disconnect_connector") {
    try {
      await withClient((client) =>
        disconnectConnector(client, {
          connectionId: text(form, "connection_id"),
          userId: user.id,
        }),
      );
      return { message: "Slack disconnected. Imported messages and history were kept." };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not disconnect Slack." };
    }
  }

  if (intent === "connect_github") {
    try {
      const connected = await withClient((client) =>
        connectGithubRepository(client, {
          workspaceId: state.workspace.id,
          userId: user.id,
          repository: text(form, "repository"),
          accessToken: text(form, "access_token"),
          encryptionKey: encryptionKey(),
        }),
      );
      const synced = await withClient((client) =>
        syncGithubConnection(client, {
          connectionId: connected.id,
          encryptionKey: encryptionKey(),
          userId: user.id,
        }),
      );
      return {
        message: `Connected ${connected.repository}. Imported ${synced.created} and updated ${synced.updated} records.`,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not connect GitHub." };
    }
  }

  if (intent === "sync_github") {
    try {
      const synced = await withClient((client) =>
        syncGithubConnection(client, {
          connectionId: text(form, "connection_id"),
          encryptionKey: encryptionKey(),
          userId: user.id,
        }),
      );
      return {
        message: `GitHub sync complete: ${synced.created} created, ${synced.updated} updated, ${synced.unchanged} unchanged.`,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not sync GitHub." };
    }
  }

  if (intent === "disconnect_github") {
    try {
      await withClient((client) =>
        disconnectGithubRepository(client, {
          connectionId: text(form, "connection_id"),
          userId: user.id,
        }),
      );
      return { message: "GitHub disconnected. Imported records and history were kept." };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not disconnect GitHub." };
    }
  }

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

function SlackConnectionForm({ reconnect = false }: { reconnect?: boolean }) {
  const navigation = useNavigation();
  const connecting =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "connect_slack";
  return (
    <Form method="post" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="intent" value="connect_slack" />
      <label className="text-xs sm:col-span-2">
        <span className="mb-1 block text-muted-foreground">Slack bot token</span>
        <input
          name="bot_token"
          type="password"
          required
          autoComplete="new-password"
          placeholder="xoxb-…"
          className="w-full rounded-md px-3 py-2 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Use a bot token with channels:read, channels:history, and users:read. Doco copies public,
        non-shared channels only and encrypts the token with this deployment&apos;s encryption key.
      </p>
      <div className="sm:col-span-2 sm:text-right">
        <button
          type="submit"
          disabled={connecting}
          className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {connecting ? "Connecting…" : reconnect ? "Reconnect Slack" : "Connect and sync"}
        </button>
      </div>
    </Form>
  );
}

function SlackConnection({ connection }: { connection: ConnectorConnectionSummary }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{connection.sourceName}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {connection.active
              ? connection.lastSyncedAt
                ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                : "Connected; first sync pending"
              : "Disconnected"}
          </p>
          {connection.lastError ? (
            <p className="mt-1 text-xs text-destructive">{connection.lastError}</p>
          ) : null}
        </div>
        {connection.active ? (
          <div className="flex gap-2">
            <Form method="post">
              <input type="hidden" name="intent" value="sync_connector" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold"
              >
                Sync now
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect_connector" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold text-destructive"
              >
                Disconnect
              </button>
            </Form>
          </div>
        ) : null}
      </div>
      <Link
        className="neu-button inline-flex rounded-md px-3 py-2 text-xs font-semibold"
        to={`/${connection.collectionHandle}`}
      >
        Slack messages
      </Link>
      {!connection.active ? <SlackConnectionForm reconnect /> : null}
    </div>
  );
}

function GithubConnectionForm({
  repository,
  submitLabel,
}: {
  repository?: string;
  submitLabel: string;
}) {
  return (
    <Form method="post" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="intent" value="connect_github" />
      <label className="text-xs">
        <span className="mb-1 block text-muted-foreground">Repository</span>
        <input
          name="repository"
          required
          defaultValue={repository}
          readOnly={Boolean(repository)}
          placeholder="owner/repository"
          className="w-full rounded-md px-3 py-2 font-mono text-sm"
        />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-muted-foreground">Fine-grained personal access token</span>
        <input
          name="access_token"
          type="password"
          required
          autoComplete="new-password"
          className="w-full rounded-md px-3 py-2 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Grant read access to Metadata, Issues, and Pull requests for this repository only.
      </p>
      <div className="sm:col-span-2 sm:text-right">
        <button
          type="submit"
          className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          {submitLabel}
        </button>
      </div>
    </Form>
  );
}

function GithubConnection({ connection }: { connection: GithubConnectionSummary }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold">{connection.repository}</p>
          <p className="text-xs text-muted-foreground">
            {connection.active
              ? connection.lastSyncedAt
                ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                : "Connected; first sync pending"
              : "Disconnected"}
          </p>
          {connection.lastError ? (
            <p className="mt-1 text-xs text-destructive">{connection.lastError}</p>
          ) : null}
        </div>
        {connection.active ? (
          <div className="flex gap-2">
            <Form method="post">
              <input type="hidden" name="intent" value="sync_github" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold"
              >
                Sync now
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect_github" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold text-destructive"
              >
                Disconnect
              </button>
            </Form>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Link
          className="neu-button rounded-md px-3 py-2 font-semibold"
          to={`/${connection.issuesCollectionHandle}`}
        >
          GitHub issues
        </Link>
        <Link
          className="neu-button rounded-md px-3 py-2 font-semibold"
          to={`/${connection.pullRequestsCollectionHandle}`}
        >
          GitHub pull requests
        </Link>
      </div>
      {!connection.active ? (
        <GithubConnectionForm repository={connection.repository} submitLabel="Reconnect GitHub" />
      ) : null}
    </div>
  );
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
      {actionData?.message ? <p className="text-sm text-foreground">{actionData.message}</p> : null}
      {actionData?.error ? <p className="text-sm text-destructive">{actionData.error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Slack</CardTitle>
          <CardDescription>
            Copy one Slack workspace&apos;s public channels into a private Doco collection. Private,
            archived, and Slack Connect channels are never imported.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.connectorConnections.find((connection) => connection.provider === "slack") ? (
            <SlackConnection
              connection={
                data.connectorConnections.find(
                  (connection) => connection.provider === "slack",
                ) as ConnectorConnectionSummary
              }
            />
          ) : (
            <SlackConnectionForm />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Import one repository&apos;s issues and pull requests into dedicated Doco collections.
            The token is encrypted with this deployment&apos;s encryption key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.githubConnections.length ? (
            data.githubConnections.map((connection) => (
              <GithubConnection key={connection.id} connection={connection} />
            ))
          ) : (
            <GithubConnectionForm submitLabel="Connect and sync" />
          )}
        </CardContent>
      </Card>

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
