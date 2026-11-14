import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withClient } from "@doco/db";
import {
  type ActivityPeriod,
  PluginInstallationError,
  WorkspaceAdminError,
  configurePluginInstallation,
  getSingleWorkspaceState,
  getWorkspaceAdminOverview,
  installPlugin,
  listPluginInstallations,
  updateWorkspaceSettings,
} from "@doco/host";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

interface ActionData {
  saved?: boolean;
  message?: string;
  error?: string;
}

const OLLAMA_PLUGIN_ID = "braino.ollama-embedding";

interface DeploymentStatus {
  version: string;
  publicHost: string;
  postgres: "Connected";
  qdrant: "Configured" | "Not configured";
  codeLinker: "Configured" | "Not configured";
  search: string;
  transport: "HTTPS" | "Loopback HTTP" | "HTTP";
}

const METRIC_PERIODS = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const satisfies readonly { value: ActivityPeriod; label: string }[];

function metricPeriod(request: Request): ActivityPeriod {
  const value = new URL(request.url).searchParams.get("period");
  return METRIC_PERIODS.some((option) => option.value === value)
    ? (value as ActivityPeriod)
    : "24h";
}

export function meta() {
  return [{ title: "Workspace administration · Braino" }];
}

function deploymentStatus(request: Request, embeddingPluginInstalled: boolean): DeploymentStatus {
  const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
  const embeddingProvider = process.env.DOCO_EMBEDDING_PROVIDER?.trim().toLowerCase();
  const hasEmbeddingKey = Boolean(
    process.env.OPENAI_API_KEY || process.env.VOYAGE_API_KEY || process.env.COHERE_API_KEY,
  );
  return {
    version: process.env.DOCO_VERSION?.trim() || "local",
    publicHost,
    postgres: "Connected",
    qdrant: process.env.QDRANT_URL?.trim() ? "Configured" : "Not configured",
    codeLinker:
      process.env.BRAINO_CODELINKER_URL?.trim() && process.env.BRAINO_CODELINKER_API_TOKEN?.trim()
        ? "Configured"
        : "Not configured",
    search: embeddingPluginInstalled
      ? "Plugin embeddings"
      : embeddingProvider === "none" || (!embeddingProvider && !hasEmbeddingKey)
        ? "Keyword search"
        : `${embeddingProvider || "automatic"} embeddings`,
    transport: publicHost.startsWith("https://")
      ? "HTTPS"
      : publicHost.startsWith("http://localhost") || publicHost.startsWith("http://127.0.0.1")
        ? "Loopback HTTP"
        : "HTTP",
  };
}

function adminResponse(error: unknown): never {
  if (error instanceof WorkspaceAdminError) {
    throw new Response(error.message, { status: error.status });
  }
  throw error;
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  try {
    const loaded = await withClient(async (client) => ({
      overview: await getWorkspaceAdminOverview(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        period: metricPeriod(request),
      }),
      plugins: await listPluginInstallations(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
      }),
    }));
    return {
      overview: loaded.overview,
      embeddingPlugin: loaded.plugins.find((plugin) => plugin.manifest.id === OLLAMA_PLUGIN_ID),
      deployment: deploymentStatus(
        request,
        loaded.plugins.some(
          (plugin) => plugin.enabled && plugin.manifest.capabilities.includes("embedding.embed"),
        ),
      ),
    };
  } catch (error) {
    adminResponse(error);
  }
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function encryptionKey(): string {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return value;
}

async function bundledOllamaPlugin() {
  const directory = process.env.BRAINO_PLUGIN_BUNDLE_DIR?.trim() || "/app/plugins";
  const [manifest, component] = await Promise.all([
    readFile(resolve(directory, "braino_ollama_embedding.manifest.json"), "utf8"),
    readFile(resolve(directory, "braino_ollama_embedding.wasm")),
  ]);
  return { manifest: JSON.parse(manifest) as unknown, component };
}

export async function action({ request }: { request: Request }): Promise<ActionData | Response> {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Sign in first." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const intent = text(form, "intent");
  try {
    if (intent === "install_ollama_embedding") {
      const bundled = await bundledOllamaPlugin();
      await withClient((client) =>
        installPlugin(client, {
          workspaceId: state.workspace.id,
          userId: user.id,
          manifest: bundled.manifest,
          component: bundled.component,
          configuration: {
            model: text(form, "embedding_model"),
            dimensions: text(form, "embedding_dimensions"),
          },
        }),
      );
      return { message: "Ollama embedding plugin installed." };
    }
    if (intent === "configure_ollama_embedding") {
      await withClient((client) =>
        configurePluginInstallation(client, {
          workspaceId: state.workspace.id,
          userId: user.id,
          installationId: text(form, "installation_id"),
          configuration: {
            model: text(form, "embedding_model"),
            dimensions: text(form, "embedding_dimensions"),
          },
          secrets: {},
          encryptionKey: encryptionKey(),
        }),
      );
      return { message: "Embedding model configuration saved." };
    }
    if (intent !== "update_workspace") {
      return Response.json({ error: "Unknown admin action." }, { status: 400 });
    }
    await withClient((client) =>
      updateWorkspaceSettings(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        name: text(form, "name"),
        constitution: text(form, "constitution"),
        timesPublic: form.has("times_public"),
        timesTimeZone: text(form, "times_timezone"),
      }),
    );
    return { saved: true };
  } catch (error) {
    if (error instanceof WorkspaceAdminError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof PluginInstallationError) return { error: error.message };
    throw error;
  }
}

function Breadcrumb({ handle }: { handle: string }) {
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/" className="hover:underline">
        Braino
      </Link>
      <span aria-hidden>›</span>
      <Link to="/" className="hover:underline">
        {handle}
      </Link>
      <span aria-hidden>›</span>
      <span>Admin</span>
    </nav>
  );
}

function Metric({
  label,
  value,
  comparison,
  note,
}: {
  label: string;
  value: number;
  comparison?: string;
  note?: string;
}) {
  return (
    <div className="neu-surface space-y-2 rounded-lg bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-semibold leading-none">{value}</span>
        {comparison ? (
          <span className="text-[11px] font-semibold text-muted-foreground">{comparison}</span>
        ) : null}
      </p>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function comparison(value: number, previous: number, period: string): string {
  const difference = value - previous;
  const change = difference > 0 ? `+${difference}` : difference < 0 ? `−${-difference}` : "±0";
  return `${change} vs previous ${period}`;
}

function AdminLink({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="neu-button block rounded-lg px-4 py-3">
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs font-normal text-muted-foreground">{description}</span>
    </Link>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-right font-mono text-xs">{value}</dd>
    </div>
  );
}

export default function AdminPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as ActionData | undefined;
  const { overview, embeddingPlugin, deployment } = data;
  const period =
    METRIC_PERIODS.find((option) => option.value === overview.activity.period) ?? METRIC_PERIODS[0];
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={<Breadcrumb handle={overview.workspace.handle} />}
        title="Workspace administration"
      >
        <p className="text-xs text-muted-foreground">
          Operate this Braino deployment and its one workspace.
        </p>
      </PageHeader>

      <section className="space-y-3" aria-labelledby="metrics-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="metrics-title" className="text-lg font-semibold">
              Metrics
            </h2>
            <p className="text-xs text-muted-foreground">Rolling activity for this workspace.</p>
          </div>
          <nav aria-label="Metrics time period" className="flex flex-wrap gap-2">
            {METRIC_PERIODS.map((option) => (
              <Link
                key={option.value}
                to={`?period=${option.value}`}
                aria-current={option.value === overview.activity.period ? "true" : undefined}
                className={`neu-button rounded-md px-3 py-1.5 text-xs font-semibold ${
                  option.value === overview.activity.period
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {option.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label={`Active agents · last ${period.label}`}
            value={overview.activity.activeAgents.current}
            comparison={comparison(
              overview.activity.activeAgents.current,
              overview.activity.activeAgents.previous,
              period.label,
            )}
            note="Distinct agents that read or wrote"
          />
          <Metric
            label={`Queries · last ${period.label}`}
            value={overview.activity.queries.current}
            comparison={comparison(
              overview.activity.queries.current,
              overview.activity.queries.previous,
              period.label,
            )}
            note={`${overview.activity.queries.byAgents} by agents`}
          />
          <Metric
            label={`Writes · last ${period.label}`}
            value={overview.activity.writes.current}
            comparison={comparison(
              overview.activity.writes.current,
              overview.activity.writes.previous,
              period.label,
            )}
            note={`${overview.activity.writes.byAgents} by agents`}
          />
          <Metric
            label={`Imports · last ${period.label}`}
            value={overview.activity.imports.current}
            comparison={comparison(
              overview.activity.imports.current,
              overview.activity.imports.previous,
              period.label,
            )}
            note="What connected sources brought in"
          />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Workspace totals</h3>
          <p className="text-xs text-muted-foreground">Current totals for this workspace.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Collections" value={overview.counts.collections} />
          <Metric label="Records" value={overview.counts.records} />
          <Metric label="Collaborators" value={overview.counts.collaborators} />
          <Metric label="Connections" value={overview.counts.connections} />
          <Metric label="Active MCP tokens" value={overview.counts.mcpTokens} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Workspace settings</CardTitle>
            <CardDescription>
              The handle is permanent because it anchors collection names and agent URLs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="update_workspace" />
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Workspace name</span>
                <input
                  name="name"
                  defaultValue={overview.workspace.name}
                  required
                  className="w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Workspace handle</span>
                <input
                  value={overview.workspace.handle}
                  readOnly
                  aria-readonly="true"
                  className="w-full rounded-md px-3 py-2 font-mono text-sm text-muted-foreground"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Constitution</span>
                <textarea
                  name="constitution"
                  defaultValue={overview.workspace.constitution}
                  rows={8}
                  className="w-full rounded-md px-3 py-2 text-sm leading-6"
                />
              </label>
              <fieldset className="neu-well space-y-3 rounded-lg p-4">
                <legend className="px-1 text-sm font-semibold">Braino Times</legend>
                <p className="text-xs text-muted-foreground">
                  Publish one local edition each calendar day. Use an IANA timezone such as
                  Africa/Lagos or America/Los_Angeles.
                </p>
                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">Publication timezone</span>
                  <input
                    name="times_timezone"
                    defaultValue={overview.workspace.timesTimeZone}
                    required
                    className="w-full rounded-md px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    name="times_public"
                    defaultChecked={overview.workspace.timesPublic}
                    className="mt-0.5"
                  />
                  <span>
                    Make Times public. Signed-out readers see stories from public collections only.
                  </span>
                </label>
                <Link to="/times" className="inline-block text-xs font-semibold hover:underline">
                  View Braino Times
                </Link>
              </fieldset>
              {actionData?.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {actionData.error}
                </p>
              ) : null}
              {actionData?.saved ? (
                <output className="block text-xs text-muted-foreground">
                  Workspace settings saved.
                </output>
              ) : null}
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                Save workspace
              </button>
            </Form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Administration</CardTitle>
              <CardDescription>
                Manage the team and the systems connected to its knowledge.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <AdminLink
                to="/collaborators"
                title="People and access"
                description="Add collaborators and manage roles."
              />
              <AdminLink
                to="/integrations"
                title="Connections"
                description="Connect sources, GitHub, and webhooks."
              />
              <AdminLink
                to="/mcp-tokens"
                title="Connect Señor Braino"
                description="Connect ChatGPT directly with instance-local OAuth."
              />
              <AdminLink
                to="/"
                title="Workspace"
                description="Return to collections and the constitution."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Deployment</CardTitle>
              <CardDescription>
                Configuration status without exposing secret values.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <StatusRow label="Version" value={deployment.version} />
                <StatusRow label="Public URL" value={deployment.publicHost} />
                <StatusRow label="PostgreSQL" value={deployment.postgres} />
                <StatusRow label="Qdrant" value={deployment.qdrant} />
                <StatusRow label="CodeLinker" value={deployment.codeLinker} />
                <StatusRow label="Search" value={deployment.search} />
                <StatusRow label="Transport" value={deployment.transport} />
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Embedding model plugin</CardTitle>
          <CardDescription>
            Run embeddings inside this deployment with Ollama. Content and vectors stay on this
            Braino instance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <input
              type="hidden"
              name="intent"
              value={embeddingPlugin ? "configure_ollama_embedding" : "install_ollama_embedding"}
            />
            {embeddingPlugin ? (
              <input type="hidden" name="installation_id" value={embeddingPlugin.id} />
            ) : null}
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Ollama model</span>
              <input
                name="embedding_model"
                defaultValue={embeddingPlugin?.configuration.model ?? "embeddinggemma"}
                required
                className="w-full rounded-md px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">Dimensions</span>
              <input
                name="embedding_dimensions"
                type="number"
                min="1"
                defaultValue={embeddingPlugin?.configuration.dimensions ?? "768"}
                required
                className="w-full rounded-md px-3 py-2 font-mono text-sm"
              />
            </label>
            <button
              type="submit"
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {embeddingPlugin ? "Save model" : "Install plugin"}
            </button>
          </Form>
          {actionData?.message ? (
            <output className="mt-3 block text-xs text-muted-foreground">
              {actionData.message}
            </output>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operations</CardTitle>
          <CardDescription>
            Run privileged maintenance on the host, outside the web process.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="neu-well overflow-x-auto rounded-md px-4 py-3 font-mono text-xs leading-6">
            <code>
              {
                "./doco doctor\n./doco backup\n./doco restore backups/<archive>.tar.gz\n./doco upgrade"
              }
            </code>
          </pre>
        </CardContent>
      </Card>
    </PageMain>
  );
}
