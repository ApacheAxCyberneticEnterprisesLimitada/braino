import { withClient } from "@doco/db";
import {
  type ActivityPeriod,
  WorkspaceAdminError,
  getSingleWorkspaceState,
  getWorkspaceAdminOverview,
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
  error?: string;
}

interface DeploymentStatus {
  version: string;
  publicHost: string;
  postgres: "Connected";
  qdrant: "Configured" | "Not configured";
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

function deploymentStatus(request: Request): DeploymentStatus {
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
    search:
      embeddingProvider === "none" || (!embeddingProvider && !hasEmbeddingKey)
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
    const overview = await withClient((client) =>
      getWorkspaceAdminOverview(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        period: metricPeriod(request),
      }),
    );
    return { overview, deployment: deploymentStatus(request) };
  } catch (error) {
    adminResponse(error);
  }
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
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
  if (text(form, "intent") !== "update_workspace") {
    return Response.json({ error: "Unknown admin action." }, { status: 400 });
  }
  try {
    await withClient((client) =>
      updateWorkspaceSettings(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        name: text(form, "name"),
        constitution: text(form, "constitution"),
      }),
    );
    return { saved: true };
  } catch (error) {
    if (error instanceof WorkspaceAdminError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
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
  const { overview, deployment } = data;
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
                title="Agents and MCP"
                description="Connect agents with revocable tokens."
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
                <StatusRow label="Search" value={deployment.search} />
                <StatusRow label="Transport" value={deployment.transport} />
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

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
